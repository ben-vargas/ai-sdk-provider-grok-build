import type {
  JSONObject,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type {
  AcpExtensionNotification,
  AcpSessionUpdateParams,
} from "./acp/protocol.js";
import {
  AcpEventNormalizer,
  type NormalizedEvent,
} from "./normalized-events.js";

function providerMetadata(
  value: unknown,
): SharedV4ProviderMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return { "grok-build": value as JSONObject };
}

/** Thin AI SDK V4 adapter over the generation-neutral ACP event normalizer. */
export class GrokBuildV4StreamEmitter {
  private readonly normalizer = new AcpEventNormalizer();
  private closed = false;
  private warnings?: SharedV4Warning[];

  constructor(
    private readonly controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
    private readonly includeRawChunks: boolean,
    private readonly onCompatibilityWarning?: (
      warning: SharedV4Warning,
    ) => void,
  ) {}

  emitStart(warnings: SharedV4Warning[], modelId: string): void {
    this.warnings = warnings;
    this.enqueue({ type: "stream-start", warnings });
    this.enqueue({
      type: "response-metadata",
      modelId,
      timestamp: new Date(),
    });
  }

  emitUpdate(update: AcpSessionUpdateParams): void {
    this.emitNormalized(this.normalizer.normalizeUpdate(update));
  }

  emitExtension(notification: AcpExtensionNotification): void {
    this.emitNormalized(this.normalizer.normalizeExtension(notification));
  }

  emitFinish(
    finishReason: LanguageModelV4FinishReason,
    usage: LanguageModelV4Usage,
    metadata: SharedV4ProviderMetadata,
  ): void {
    this.emitNormalized(this.normalizer.finish());
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
      // The consumer may already have cancelled the stream.
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

  emitNormalized(events: NormalizedEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case "text-start":
        case "text-end":
        case "reasoning-start":
        case "reasoning-end":
          this.enqueue({ type: event.kind, id: event.id });
          break;
        case "text-delta":
        case "reasoning-delta":
          this.enqueue({
            type: event.kind,
            id: event.id,
            delta: event.delta,
          });
          break;
        case "tool-call": {
          const input = JSON.stringify(event.input);
          const metadata = providerMetadata(event.metadata);
          this.enqueue({
            type: "tool-input-start",
            id: event.toolCallId,
            toolName: event.toolName,
            providerExecuted: true,
            dynamic: true,
            title: event.title,
            providerMetadata: metadata,
          });
          this.enqueue({
            type: "tool-input-delta",
            id: event.toolCallId,
            delta: input,
          });
          this.enqueue({ type: "tool-input-end", id: event.toolCallId });
          this.enqueue({
            type: "tool-call",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input,
            providerExecuted: true,
            dynamic: true,
            providerMetadata: metadata,
          });
          break;
        }
        case "tool-result":
          this.enqueue({
            type: "tool-result",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result ?? {},
            dynamic: true,
            ...(event.preliminary ? { preliminary: true } : {}),
            ...(event.isError ? { isError: true } : {}),
            providerMetadata: providerMetadata(event.metadata),
          });
          break;
        case "raw":
          if (!event.conditional || this.includeRawChunks) {
            this.enqueue({ type: "raw", rawValue: event.value });
          }
          break;
        case "compatibility-warning": {
          const warning: SharedV4Warning = {
            type: "compatibility",
            feature: event.feature,
            details: event.message,
          };
          this.warnings?.push(warning);
          this.onCompatibilityWarning?.(warning);
          this.enqueue({
            type: "raw",
            rawValue: {
              type: "grok-build-compatibility-warning",
              feature: event.feature,
              message: event.message,
            },
          });
          break;
        }
      }
    }
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
