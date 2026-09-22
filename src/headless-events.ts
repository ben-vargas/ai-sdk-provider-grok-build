import { randomUUID } from "node:crypto";
import { AcpProtocolError } from "./acp/errors.js";
import { GrokCliError } from "./errors.js";
import type { JsonValue } from "./acp/protocol.js";
import type { NormalizedEvent } from "./normalized-events.js";
import { redactSensitiveData } from "./redact.js";

export interface HeadlessTerminalEvent {
  type: "end";
  stopReason: string;
  sessionId?: string;
  requestId?: string;
  usage?: Record<string, unknown>;
  modelUsage?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function requiredString(
  record: Record<string, unknown>,
  eventType: string,
  ...keys: string[]
): string {
  const value = stringField(record, ...keys);
  if (value) return value;
  throw new AcpProtocolError(
    `Malformed Grok headless '${eventType}' event: '${keys[0]}' must be a non-empty string.`,
    { data: redactSensitiveData(record) },
  );
}

interface ToolState {
  name: string;
  finalEmitted: boolean;
}

function mayAffectStreamSemantics(type: string): boolean {
  if (type === "auto_compact_completed") return false;
  const tokens = type
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean);
  return tokens.some((token) =>
    [
      "tool",
      "permission",
      "usage",
      "complete",
      "completed",
      "completion",
      "finish",
      "finished",
      "end",
      "ended",
    ].includes(token),
  );
}

/** Generation-neutral normalization for Grok 1.x streaming-json records. */
export class HeadlessEventNormalizer {
  private active?: { type: "text" | "reasoning"; id: string };
  private readonly tools = new Map<string, ToolState>();
  private readonly warned = new Set<string>();

  normalize(value: unknown): NormalizedEvent[] {
    if (!isRecord(value)) {
      throw new AcpProtocolError(
        "Grok headless output must contain JSON objects.",
      );
    }
    const raw = redactSensitiveData(value);
    if (!raw)
      throw new AcpProtocolError("Grok output was not JSON-compatible.");
    const type = requiredString(value, "event", "type");
    const events: NormalizedEvent[] = [
      { kind: "raw", value: raw, conditional: true },
    ];

    if (type === "thought" || type === "text") {
      const data = value.data;
      if (typeof data !== "string") {
        throw new AcpProtocolError(
          `Malformed Grok headless '${type}' event: 'data' must be a string.`,
          { data: raw },
        );
      }
      events.push(
        ...this.delta(type === "thought" ? "reasoning" : "text", data),
      );
      return events;
    }
    if (type === "error") {
      const message = requiredString(value, type, "message", "error");
      throw new GrokCliError(message, {
        code: "GROK_CLI_HEADLESS_ERROR",
      });
    }
    if (type === "tool_call") {
      const id = requiredString(
        value,
        type,
        "toolCallId",
        "tool_call_id",
        "id",
      );
      const name = requiredString(value, type, "toolName", "tool_name", "name");
      const input = redactSensitiveData(
        value.rawInput ?? value.raw_input ?? value.input ?? {},
      );
      if (input === undefined) {
        throw new AcpProtocolError("Grok tool input was not JSON-compatible.", {
          data: raw,
        });
      }
      if (this.tools.has(id)) {
        throw new AcpProtocolError(`Duplicate Grok tool call ID '${id}'.`, {
          data: raw,
        });
      }
      this.tools.set(id, { name, finalEmitted: false });
      events.push(...this.closeActive(), {
        kind: "tool-call",
        toolCallId: id,
        toolName: name,
        title: stringField(value, "title") ?? name,
        input,
        metadata: raw,
      });
      return events;
    }
    if (type === "tool_call_update") {
      const id = requiredString(
        value,
        type,
        "toolCallId",
        "tool_call_id",
        "id",
      );
      const tracked = this.tools.get(id);
      if (!tracked) {
        throw new AcpProtocolError(
          `Grok tool update '${id}' cannot be correlated to a tool call.`,
          { data: raw },
        );
      }
      const status = stringField(value, "status");
      if (tracked.finalEmitted) {
        if (status === "completed" || status === "failed") return events;
        throw new AcpProtocolError(
          `Grok tool update '${id}' arrived after its final result.`,
          { data: raw },
        );
      }
      if (status === undefined) return events;
      if (!["pending", "in_progress", "completed", "failed"].includes(status)) {
        throw new AcpProtocolError(
          `Unknown Grok tool status '${status}' affects completion.`,
          { data: raw },
        );
      }
      const final = status === "completed" || status === "failed";
      if (final) tracked.finalEmitted = true;
      const result =
        redactSensitiveData(
          value.rawOutput ?? value.raw_output ?? value.output ?? { status },
        ) ?? ({ status } as JsonValue);
      events.push(...this.closeActive(), {
        kind: "tool-result",
        toolCallId: id,
        toolName: tracked.name,
        result,
        preliminary: !final,
        isError: status === "failed",
        metadata: raw,
      });
      return events;
    }
    if (type === "usage" || type === "end" || type === "available_commands") {
      return events;
    }
    if (mayAffectStreamSemantics(type)) {
      throw new AcpProtocolError(
        `Unknown Grok headless event '${type}' may affect completion, usage, permissions, or tool correlation.`,
        { data: raw },
      );
    }
    events[0] = { kind: "raw", value: raw, conditional: false };
    if (!this.warned.has(type)) {
      this.warned.add(type);
      events.push({
        kind: "compatibility-warning",
        feature: `Grok headless event '${type}'`,
        message: `Unknown optional Grok event '${type}' was preserved as redacted raw data.`,
      });
    }
    return events;
  }

  finish(): NormalizedEvent[] {
    const incomplete = [...this.tools].find(([, tool]) => !tool.finalEmitted);
    if (incomplete) {
      throw new AcpProtocolError(
        `Grok completed before tool call '${incomplete[0]}' emitted a final result.`,
      );
    }
    return this.closeActive();
  }

  private delta(type: "text" | "reasoning", delta: string): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    if (this.active?.type !== type) {
      events.push(...this.closeActive());
      this.active = { type, id: randomUUID() };
      events.push({ kind: `${type}-start`, id: this.active.id });
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
}

export function isHeadlessTerminalEvent(
  value: unknown,
): value is HeadlessTerminalEvent {
  return (
    isRecord(value) &&
    value.type === "end" &&
    typeof value.stopReason === "string" &&
    value.stopReason.length > 0
  );
}
