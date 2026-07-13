import type {
  JSONObject,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
  SharedV3Warning,
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
): SharedV3ProviderMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return { "grok-build": value as JSONObject };
}

/** Thin AI SDK V3 adapter over the generation-neutral ACP event normalizer. */
export class GrokBuildV3StreamEmitter {
  private readonly normalizer = new AcpEventNormalizer();
  private closed = false;
  private warnings?: SharedV3Warning[];

  constructor(
    private readonly controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
    private readonly includeRawChunks: boolean,
    private readonly onCompatibilityWarning?: (
      warning: SharedV3Warning,
    ) => void,
  ) {}

  emitStart(warnings: SharedV3Warning[], modelId: string): void {
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
    finishReason: LanguageModelV3FinishReason,
    usage: LanguageModelV3Usage,
    metadata: SharedV3ProviderMetadata,
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

  private emitNormalized(events: NormalizedEvent[]): void {
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
          const warning: SharedV3Warning = {
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

  private enqueue(part: LanguageModelV3StreamPart): void {
    if (this.closed) return;
    try {
      this.controller.enqueue(part);
    } catch {
      this.closed = true;
    }
  }
}
