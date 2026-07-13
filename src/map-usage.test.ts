import { describe, expect, it } from "vitest";
import { grokBuildProviderMetadata, mapGrokBuildUsage } from "./map-usage.js";

describe("mapGrokBuildUsage", () => {
  it("extracts nested fixture-style usage and subtracts cache reads", () => {
    expect(
      mapGrokBuildUsage({
        usage: {
          inputTokens: 100,
          outputTokens: 25,
          totalTokens: 125,
          cachedReadTokens: 40,
          reasoningTokens: 7,
          modelCalls: 2,
          numTurns: 2,
        },
      }),
    ).toEqual({
      inputTokens: {
        total: 100,
        noCache: 60,
        cacheRead: 40,
        cacheWrite: undefined,
      },
      outputTokens: { total: 25, text: undefined, reasoning: 7 },
      raw: {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        cachedReadTokens: 40,
        reasoningTokens: 7,
        modelCalls: 2,
        numTurns: 2,
      },
    });
  });

  it("accepts legacy top-level usage and never reports negative no-cache tokens", () => {
    expect(
      mapGrokBuildUsage({
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        cachedReadTokens: 9,
        reasoningTokens: 1,
      }),
    ).toMatchObject({
      inputTokens: { total: 3, noCache: 0, cacheRead: 9 },
      outputTokens: { total: 2, reasoning: 1 },
    });
  });

  it("returns an unknown usage shape when ACP omits metadata", () => {
    expect(mapGrokBuildUsage()).toEqual({
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: undefined,
        text: undefined,
        reasoning: undefined,
      },
      raw: undefined,
    });
  });
});

describe("grokBuildProviderMetadata", () => {
  it("uses rich ACP identifiers and model usage when present", () => {
    expect(
      grokBuildProviderMetadata(
        {
          sessionId: "session-meta",
          requestId: "request-1",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
            modelUsage: {
              "grok-4.5": {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
                modelCalls: 2,
              },
            },
          },
        },
        "end_turn",
        "session-fallback",
      ),
    ).toEqual({
      "grok-build": {
        sessionId: "session-meta",
        requestId: "request-1",
        modelUsage: {
          "grok-4.5": {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
            modelCalls: 2,
          },
        },
        stopReason: "end_turn",
      },
    });
  });

  it("falls back to the prepared session ID", () => {
    expect(
      grokBuildProviderMetadata(null, "cancelled", "session-fallback"),
    ).toEqual({
      "grok-build": {
        sessionId: "session-fallback",
        stopReason: "cancelled",
      },
    });
  });
});
