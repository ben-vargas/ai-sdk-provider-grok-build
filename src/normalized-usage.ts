import type {
  AcpModelInfo,
  AcpPromptResultMeta,
  AcpPromptUsage,
  AcpStopReason,
  JsonValue,
} from "./acp/protocol.js";
import { redactSensitiveData } from "./redact.js";

export interface NormalizedUsage {
  inputTotal?: number;
  inputNoCache?: number;
  cacheRead?: number;
  cacheWrite?: number;
  outputTotal?: number;
  reasoning?: number;
  raw?: JsonValue;
}

export interface NormalizedSessionMetadata {
  sessionId: string;
  resolvedModelId: string;
  availableModels?: AcpModelInfo[];
  currentReasoningEffort?: string;
  supportedReasoningEfforts?: string[];
  agentVersion?: string;
}

export interface NormalizedCompletionMetadata {
  sessionId: string;
  requestId?: string;
  promptId?: string;
  stopReason: AcpStopReason;
  resolvedModel: string;
  availableModels?: JsonValue;
  currentReasoningEffort?: string;
  supportedReasoningEfforts?: string[];
  agentVersion?: string;
  modelUsage?: JsonValue;
}

function resolvedUsage(
  meta?: AcpPromptResultMeta | null,
): Partial<AcpPromptUsage> | undefined {
  if (
    !meta ||
    (meta.inputTokens === undefined &&
      meta.outputTokens === undefined &&
      meta.totalTokens === undefined &&
      meta.cachedReadTokens === undefined &&
      meta.reasoningTokens === undefined)
  ) {
    return meta?.usage;
  }
  return {
    ...(meta.inputTokens !== undefined
      ? { inputTokens: meta.inputTokens }
      : {}),
    ...(meta.outputTokens !== undefined
      ? { outputTokens: meta.outputTokens }
      : {}),
    ...(meta.totalTokens !== undefined
      ? { totalTokens: meta.totalTokens }
      : {}),
    ...(meta.cachedReadTokens !== undefined
      ? { cachedReadTokens: meta.cachedReadTokens }
      : {}),
    ...(meta.reasoningTokens !== undefined
      ? { reasoningTokens: meta.reasoningTokens }
      : {}),
  };
}

export function normalizeAcpUsage(
  meta?: AcpPromptResultMeta | null,
): NormalizedUsage {
  const usage = resolvedUsage(meta);
  return {
    inputTotal: usage?.inputTokens,
    cacheRead: usage?.cachedReadTokens,
    outputTotal: usage?.outputTokens,
    reasoning: usage?.reasoningTokens,
    raw: meta?.usage
      ? redactSensitiveData(meta.usage)
      : usage
        ? redactSensitiveData(usage)
        : undefined,
  };
}

export function normalizeCompletionMetadata(
  meta: AcpPromptResultMeta | null | undefined,
  stopReason: AcpStopReason,
  session: NormalizedSessionMetadata,
): NormalizedCompletionMetadata {
  return {
    sessionId: meta?.sessionId ?? session.sessionId,
    requestId: meta?.requestId,
    promptId: meta?.promptId,
    stopReason,
    resolvedModel: meta?.modelId ?? session.resolvedModelId,
    availableModels: session.availableModels
      ? redactSensitiveData(session.availableModels)
      : undefined,
    currentReasoningEffort: session.currentReasoningEffort,
    supportedReasoningEfforts: session.supportedReasoningEfforts,
    agentVersion: session.agentVersion,
    modelUsage: meta?.usage?.modelUsage
      ? redactSensitiveData(meta.usage.modelUsage)
      : undefined,
  };
}
