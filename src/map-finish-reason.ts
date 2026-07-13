import type { LanguageModelV4FinishReason } from "@ai-sdk/provider";
import type { AcpStopReason } from "./acp/protocol.js";

export function mapGrokBuildFinishReason(
  stopReason: AcpStopReason,
): LanguageModelV4FinishReason {
  const normalized = stopReason.toLowerCase();
  let unified: LanguageModelV4FinishReason["unified"];
  if (normalized === "end_turn" || normalized === "stop") {
    unified = "stop";
  } else if (
    normalized === "max_tokens" ||
    normalized === "max_turn_requests" ||
    normalized.includes("limit") ||
    normalized.includes("max_turn") ||
    normalized.includes("max_token")
  ) {
    unified = "length";
  } else if (normalized.includes("refusal")) {
    unified = "content-filter";
  } else if (normalized.includes("error") || normalized.includes("failed")) {
    unified = "error";
  } else {
    unified = "other";
  }
  return { unified, raw: stopReason };
}
