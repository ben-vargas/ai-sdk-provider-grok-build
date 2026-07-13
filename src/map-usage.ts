import type {
  JSONObject,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import type {
  NormalizedCompletionMetadata,
  NormalizedUsage,
} from "./normalized-usage.js";

/** Thin AI SDK V3 usage adapter over normalized ACP accounting. */
export function mapGrokBuildUsage(
  usage: NormalizedUsage,
): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage.inputTotal,
      noCache: undefined,
      cacheRead: usage.cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage.outputTotal,
      text: undefined,
      reasoning: usage.reasoning,
    },
    raw:
      usage.raw && typeof usage.raw === "object" && !Array.isArray(usage.raw)
        ? (usage.raw as JSONObject)
        : undefined,
  };
}

export function grokBuildProviderMetadata(
  metadata: NormalizedCompletionMetadata,
): SharedV3ProviderMetadata {
  return {
    "grok-build": {
      sessionId: metadata.sessionId,
      ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
      ...(metadata.promptId ? { promptId: metadata.promptId } : {}),
      stopReason: metadata.stopReason,
      resolvedModel: metadata.resolvedModel,
      ...(metadata.availableModels
        ? { availableModels: metadata.availableModels }
        : {}),
      ...(metadata.currentReasoningEffort
        ? { currentReasoningEffort: metadata.currentReasoningEffort }
        : {}),
      ...(metadata.supportedReasoningEfforts
        ? {
            supportedReasoningEfforts: metadata.supportedReasoningEfforts,
          }
        : {}),
      ...(metadata.agentVersion ? { agentVersion: metadata.agentVersion } : {}),
      ...(metadata.modelUsage ? { modelUsage: metadata.modelUsage } : {}),
    },
  };
}
