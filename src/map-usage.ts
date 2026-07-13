import type {
  JSONObject,
  JSONValue,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import type {
  AcpModelUsage,
  AcpPromptResultMeta,
  AcpPromptUsage,
  AcpStopReason,
} from "./acp/protocol.js";

function jsonValue(value: unknown): JSONValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

function resolvedUsage(
  meta?: AcpPromptResultMeta | null,
): AcpPromptUsage | AcpModelUsage | undefined {
  return (
    meta?.usage ??
    (meta && (meta.inputTokens !== undefined || meta.outputTokens !== undefined)
      ? {
          inputTokens: meta.inputTokens ?? 0,
          outputTokens: meta.outputTokens ?? 0,
          totalTokens: meta.totalTokens ?? 0,
          cachedReadTokens: meta.cachedReadTokens,
          reasoningTokens: meta.reasoningTokens,
        }
      : undefined)
  );
}

export function mapGrokBuildUsage(
  meta?: AcpPromptResultMeta | null,
): LanguageModelV4Usage {
  const usage = resolvedUsage(meta);
  const input = usage?.inputTokens;
  const cached = usage?.cachedReadTokens;
  return {
    inputTokens: {
      total: input,
      noCache:
        input === undefined ? undefined : Math.max(0, input - (cached ?? 0)),
      cacheRead: cached,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage?.outputTokens,
      text: undefined,
      reasoning: usage?.reasoningTokens,
    },
    raw: usage ? (jsonValue(usage) as JSONObject) : undefined,
  };
}

export function grokBuildProviderMetadata(
  meta: AcpPromptResultMeta | null | undefined,
  stopReason: AcpStopReason,
  fallbackSessionId: string,
): SharedV4ProviderMetadata {
  const modelUsage = meta?.usage?.modelUsage;
  return {
    "grok-build": {
      sessionId: meta?.sessionId ?? fallbackSessionId,
      ...(meta?.requestId ? { requestId: meta.requestId } : {}),
      ...(modelUsage ? { modelUsage: jsonValue(modelUsage) } : {}),
      stopReason,
    },
  };
}
