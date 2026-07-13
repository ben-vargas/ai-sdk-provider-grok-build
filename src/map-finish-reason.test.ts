import { describe, expect, it } from "vitest";
import { mapGrokBuildFinishReason } from "./map-finish-reason.js";

describe("mapGrokBuildFinishReason", () => {
  it.each([
    ["end_turn", "stop"],
    ["stop", "stop"],
    ["max_tokens", "length"],
    ["max_turn_requests", "length"],
    ["rate_limit", "length"],
    ["token_limit_reached", "length"],
    ["max_turns_reached", "length"],
    ["refusal", "content-filter"],
    ["safety_refusal", "content-filter"],
    ["error", "error"],
    ["tool_failed", "error"],
    ["internal_error", "error"],
    ["cancelled", "other"],
    ["future_stop_reason", "other"],
  ] as const)(
    "maps %s to %s while preserving the raw reason",
    (raw, unified) => {
      expect(mapGrokBuildFinishReason(raw)).toEqual({ unified, raw });
    },
  );
});
