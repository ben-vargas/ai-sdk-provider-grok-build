import { randomUUID } from "node:crypto";
import { AcpProtocolError } from "./acp/errors.js";
import type {
  AcpExtensionNotification,
  AcpSessionUpdateParams,
  AcpToolCallContent,
  JsonValue,
} from "./acp/protocol.js";
import { redactSensitiveData } from "./redact.js";
import { isRecord } from "./type-guards.js";

export interface NormalizedCompatibilityWarning {
  kind: "compatibility-warning";
  feature: string;
  message: string;
}

export type NormalizedEvent =
  | {
      kind: "text-start" | "text-end" | "reasoning-start" | "reasoning-end";
      id: string;
    }
  | { kind: "text-delta" | "reasoning-delta"; id: string; delta: string }
  | {
      kind: "tool-call";
      toolCallId: string;
      toolName: string;
      title: string;
      input: JsonValue;
      metadata?: JsonValue;
    }
  | {
      kind: "tool-result";
      toolCallId: string;
      toolName: string;
      result: JsonValue;
      preliminary: boolean;
      isError: boolean;
      metadata?: JsonValue;
    }
  | { kind: "raw"; value: JsonValue; conditional: boolean }
  | NormalizedCompatibilityWarning;

interface TrackedTool {
  name: string;
  finalEmitted: boolean;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  eventKind: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AcpProtocolError(
      `Malformed ACP '${eventKind}' update: '${key}' must be a non-empty string.`,
      { data: redactSensitiveData(record) },
    );
  }
  return value;
}

function toolContent(content: unknown): JsonValue | undefined {
  if (!Array.isArray(content)) return undefined;
  return redactSensitiveData(
    (content as AcpToolCallContent[]).map((item) =>
      item.type === "content" ? item.content : item,
    ),
  );
}

export class AcpEventNormalizer {
  private active?: { type: "text" | "reasoning"; id: string };
  private readonly tools = new Map<string, TrackedTool>();
  private readonly warnedUnknownKinds = new Set<string>();

  normalizeUpdate(params: AcpSessionUpdateParams): NormalizedEvent[] {
    const raw = redactSensitiveData(params);
    if (!raw) throw new AcpProtocolError("ACP update was not JSON-compatible.");
    const events: NormalizedEvent[] = [
      { kind: "raw", value: raw, conditional: true },
    ];
    const update = params.update as unknown;
    if (!isRecord(update)) {
      throw new AcpProtocolError("Malformed ACP session/update payload.", {
        data: raw,
      });
    }
    const eventKind = requiredString(update, "sessionUpdate", "session/update");

    if (
      eventKind === "agent_message_chunk" ||
      eventKind === "agent_thought_chunk"
    ) {
      if (!isRecord(update.content) || update.content.type !== "text") {
        throw new AcpProtocolError(
          `Malformed ACP '${eventKind}' update: a text content block is required.`,
          { data: raw },
        );
      }
      if (typeof update.content.text !== "string") {
        throw new AcpProtocolError(
          `Malformed ACP '${eventKind}' update: 'text' must be a string.`,
          { data: raw },
        );
      }
      const text = update.content.text;
      const type = eventKind === "agent_message_chunk" ? "text" : "reasoning";
      events.push(...this.emitDelta(type, text, update.messageId));
      return events;
    }

    if (eventKind === "tool_call") {
      events.push(...this.emitToolCall(update, raw));
      return events;
    }
    if (eventKind === "tool_call_update") {
      events.push(...this.emitToolResult(update, raw));
      return events;
    }
    if (
      eventKind === "user_message_chunk" ||
      eventKind === "available_commands_update" ||
      eventKind === "plan"
    ) {
      return events;
    }

    if (
      /(?:tool|complete|completion|finish|permission|usage)/i.test(eventKind)
    ) {
      throw new AcpProtocolError(
        `Unknown ACP update '${eventKind}' may affect completion, tool identity, permissions, or usage.`,
        { data: raw },
      );
    }
    events[0] = { kind: "raw", value: raw, conditional: false };
    if (!this.warnedUnknownKinds.has(eventKind)) {
      this.warnedUnknownKinds.add(eventKind);
      events.push({
        kind: "compatibility-warning",
        feature: `ACP session/update '${eventKind}'`,
        message: `Unknown optional ACP update '${eventKind}' was preserved as redacted raw data.`,
      });
    }
    return events;
  }

  normalizeExtension(
    notification: AcpExtensionNotification,
  ): NormalizedEvent[] {
    const value = redactSensitiveData(notification);
    return value ? [{ kind: "raw", value, conditional: false }] : [];
  }

  finish(): NormalizedEvent[] {
    const incomplete = [...this.tools.entries()].find(
      ([, tool]) => !tool.finalEmitted,
    );
    if (incomplete) {
      throw new AcpProtocolError(
        `ACP prompt completed before tool call '${incomplete[0]}' emitted a final result.`,
      );
    }
    return this.closeActive();
  }

  private emitDelta(
    type: "text" | "reasoning",
    delta: string,
    preferredId: unknown,
  ): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const requestedId =
      typeof preferredId === "string" && preferredId.length > 0
        ? preferredId
        : undefined;
    if (
      this.active?.type !== type ||
      (requestedId !== undefined && requestedId !== this.active.id)
    ) {
      events.push(...this.closeActive());
      const id = requestedId ?? randomUUID();
      this.active = { type, id };
      events.push({ kind: `${type}-start`, id });
    }
    events.push({ kind: `${type}-delta`, id: this.active.id, delta });
    return events;
  }

  private closeActive(): NormalizedEvent[] {
    if (!this.active) return [];
    const { type, id } = this.active;
    this.active = undefined;
    return [{ kind: `${type}-end`, id }];
  }

  private emitToolCall(
    update: Record<string, unknown>,
    raw: JsonValue,
  ): NormalizedEvent[] {
    const toolCallId = requiredString(update, "toolCallId", "tool_call");
    const title = requiredString(update, "title", "tool_call");
    if (!isRecord(update.rawInput)) {
      throw new AcpProtocolError(
        "Malformed ACP 'tool_call' update: 'rawInput' must be an object.",
        { data: raw },
      );
    }
    const meta = isRecord(update._meta) ? update._meta : undefined;
    const tool =
      meta && isRecord(meta["x.ai/tool"]) ? meta["x.ai/tool"] : undefined;
    const toolName =
      tool && typeof tool.name === "string" && tool.name.length > 0
        ? tool.name
        : title;
    const input = redactSensitiveData(update.rawInput) ?? {};
    this.tools.set(toolCallId, { name: toolName, finalEmitted: false });
    return [
      ...this.closeActive(),
      {
        kind: "tool-call",
        toolCallId,
        toolName,
        title,
        input,
        metadata: redactSensitiveData({
          title,
          kind: tool?.kind,
          namespace: tool?.namespace,
          rawInput: update.rawInput,
        }),
      },
    ];
  }

  private emitToolResult(
    update: Record<string, unknown>,
    raw: JsonValue,
  ): NormalizedEvent[] {
    const toolCallId = requiredString(update, "toolCallId", "tool_call_update");
    if (update.status === undefined) return this.closeActive();
    const status = requiredString(update, "status", "tool_call_update");
    if (!["pending", "in_progress", "completed", "failed"].includes(status)) {
      throw new AcpProtocolError(
        `Unknown ACP tool status '${status}' affects result completion.`,
        { data: raw },
      );
    }
    const tracked = this.tools.get(toolCallId);
    if (!tracked) {
      throw new AcpProtocolError(
        `ACP tool update '${toolCallId}' cannot be correlated to a tool identity.`,
        { data: raw },
      );
    }
    const isFinal = status === "completed" || status === "failed";
    if (tracked.finalEmitted) {
      if (isFinal) return this.closeActive();
      throw new AcpProtocolError(
        `ACP tool update '${toolCallId}' emitted '${status}' after its final result.`,
        { data: raw },
      );
    }
    const result =
      redactSensitiveData(update.rawOutput) ??
      toolContent(update.content) ??
      ({ status } as JsonValue);
    if (tracked && isFinal) tracked.finalEmitted = true;
    return [
      ...this.closeActive(),
      {
        kind: "tool-result",
        toolCallId,
        toolName: tracked.name,
        result,
        preliminary: !isFinal,
        isError: status === "failed",
        metadata: redactSensitiveData({
          status,
          title: update.title,
          rawOutput: update.rawOutput,
          content: update.content,
        }),
      },
    ];
  }
}
