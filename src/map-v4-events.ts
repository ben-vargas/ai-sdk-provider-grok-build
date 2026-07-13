import type {
  JSONObject,
  JSONValue,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import type {
  AcpMessageChunkUpdate,
  AcpSessionUpdateParams,
  AcpToolCallProgressUpdate,
  AcpToolCallUpdate,
} from "./acp/protocol.js";

interface ToolState {
  name: string;
  finalEmitted: boolean;
}

function jsonValue(value: unknown): NonNullable<JSONValue> {
  return (JSON.parse(JSON.stringify(value ?? {})) ??
    {}) as NonNullable<JSONValue>;
}

function providerMetadata(
  value: Record<string, unknown>,
): SharedV4ProviderMetadata {
  return {
    "grok-build": jsonValue(value) as JSONObject,
  };
}

export class GrokBuildV4StreamEmitter {
  private active?: { type: "text" | "reasoning"; id: string };
  private readonly tools = new Map<string, ToolState>();
  private closed = false;

  constructor(
    private readonly controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
    private readonly includeRawChunks: boolean,
  ) {}

  emitStart(warnings: SharedV4Warning[], modelId: string): void {
    this.enqueue({ type: "stream-start", warnings });
    this.enqueue({
      type: "response-metadata",
      id: generateId(),
      timestamp: new Date(),
      modelId,
    });
  }

  emitRaw(rawValue: unknown): void {
    if (this.includeRawChunks) this.enqueue({ type: "raw", rawValue });
  }

  emitExtension(rawValue: unknown): void {
    this.enqueue({ type: "raw", rawValue });
  }

  emitUpdate(params: AcpSessionUpdateParams): void {
    this.emitRaw(params);
    const update = params.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (isTextChunk(update)) {
          this.emitDelta("text", update.content.text, update.messageId);
        }
        break;
      case "agent_thought_chunk":
        if (isTextChunk(update)) {
          this.emitDelta("reasoning", update.content.text, update.messageId);
        }
        break;
      case "tool_call":
        if (isToolCall(update)) this.emitToolCall(update);
        break;
      case "tool_call_update":
        if (isToolUpdate(update)) this.emitToolResult(update);
        break;
      default:
        break;
    }
  }

  emitFinish(
    finishReason: LanguageModelV4FinishReason,
    usage: LanguageModelV4Usage,
    metadata: SharedV4ProviderMetadata,
  ): void {
    this.closeActive();
    this.enqueue({
      type: "finish",
      finishReason,
      usage,
      providerMetadata: metadata,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // The consumer may have cancelled the stream after ACP cancellation.
    }
  }

  error(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.error(error);
    } catch {
      // The consumer may already have cancelled the stream.
    }
  }

  private emitDelta(
    type: "text" | "reasoning",
    delta: string,
    preferredId?: string,
  ): void {
    if (this.active?.type !== type) {
      this.closeActive();
      const id = preferredId ?? generateId();
      this.active = { type, id };
      this.enqueue({ type: `${type}-start`, id } as LanguageModelV4StreamPart);
    }
    const id = this.active.id;
    this.enqueue({
      type: `${type}-delta`,
      id,
      delta,
    } as LanguageModelV4StreamPart);
  }

  private closeActive(): void {
    if (!this.active) return;
    const { type, id } = this.active;
    this.active = undefined;
    this.enqueue({ type: `${type}-end`, id } as LanguageModelV4StreamPart);
  }

  private emitToolCall(update: AcpToolCallUpdate): void {
    this.closeActive();
    const tool = update._meta?.["x.ai/tool"];
    const toolName = tool?.name ?? update.title;
    const input = JSON.stringify(update.rawInput ?? {});
    this.tools.set(update.toolCallId, { name: toolName, finalEmitted: false });
    const metadata = providerMetadata({
      title: update.title,
      kind: tool?.kind,
      namespace: tool?.namespace,
      rawInput: update.rawInput,
    });
    this.enqueue({
      type: "tool-input-start",
      id: update.toolCallId,
      toolName,
      providerExecuted: true,
      dynamic: true,
      title: update.title,
      providerMetadata: metadata,
    });
    if (input) {
      this.enqueue({
        type: "tool-input-delta",
        id: update.toolCallId,
        delta: input,
      });
    }
    this.enqueue({ type: "tool-input-end", id: update.toolCallId });
    this.enqueue({
      type: "tool-call",
      toolCallId: update.toolCallId,
      toolName,
      input,
      providerExecuted: true,
      dynamic: true,
      providerMetadata: metadata,
    });
  }

  private emitToolResult(update: AcpToolCallProgressUpdate): void {
    if (!update.status) return;
    this.closeActive();
    const tracked = this.tools.get(update.toolCallId);
    const isFinal = update.status === "completed" || update.status === "failed";
    if (isFinal && tracked?.finalEmitted) return;
    const toolName =
      tracked?.name ??
      update._meta?.["x.ai/tool"]?.name ??
      update.title ??
      "unknown_tool";
    const content = update.content?.map((item) => {
      if (item.type === "content") return item.content;
      return item;
    });
    const result = update.rawOutput ?? content ?? { status: update.status };
    this.enqueue({
      type: "tool-result",
      toolCallId: update.toolCallId,
      toolName,
      result: jsonValue(result),
      dynamic: true,
      ...(isFinal ? {} : { preliminary: true }),
      ...(update.status === "failed" ? { isError: true } : {}),
      providerMetadata: providerMetadata({
        status: update.status,
        title: update.title,
        rawOutput: update.rawOutput,
        content: update.content,
      }),
    });
    if (tracked && isFinal) tracked.finalEmitted = true;
  }

  private enqueue(part: LanguageModelV4StreamPart): void {
    if (this.closed) return;
    try {
      this.controller.enqueue(part);
    } catch {
      this.closed = true;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTextChunk(value: unknown): value is AcpMessageChunkUpdate & {
  content: { type: "text"; text: string };
} {
  if (!isRecord(value) || !isRecord(value.content)) return false;
  return (
    value.content.type === "text" && typeof value.content.text === "string"
  );
}

function isToolCall(value: unknown): value is AcpToolCallUpdate {
  return (
    isRecord(value) &&
    typeof value.toolCallId === "string" &&
    typeof value.title === "string" &&
    isRecord(value.rawInput)
  );
}

function isToolUpdate(value: unknown): value is AcpToolCallProgressUpdate {
  return isRecord(value) && typeof value.toolCallId === "string";
}
