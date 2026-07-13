import { describe, expect, it } from "vitest";
import { grokBuildProviderMetadata, mapGrokBuildUsage } from "./map-usage.js";
import {
  normalizeAcpUsage,
  normalizeCompletionMetadata,
} from "./normalized-usage.js";

describe("mapGrokBuildUsage", () => {
  it("extracts nested fixture-style usage and subtracts cache reads", () => {
    expect(
      mapGrokBuildUsage(
        normalizeAcpUsage({
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
      ),
    ).toEqual({
      inputTokens: {
        total: 100,
        noCache: undefined,
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

  it("preserves partial top-level usage without fabricating absent totals", () => {
    expect(
      mapGrokBuildUsage(
        normalizeAcpUsage({
          inputTokens: 3,
          cachedReadTokens: 9,
          reasoningTokens: 1,
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          },
        }),
      ),
    ).toMatchObject({
      inputTokens: { total: 3, noCache: undefined, cacheRead: 9 },
      outputTokens: { total: undefined, reasoning: 1 },
      raw: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
  });

  it("returns an unknown usage shape when ACP omits metadata", () => {
    expect(mapGrokBuildUsage(normalizeAcpUsage())).toEqual({
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
        normalizeCompletionMetadata(
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
          {
            sessionId: "session-fallback",
            resolvedModelId: "grok-4.5",
            availableModels: [{ modelId: "grok-4.5", name: "Grok 4.5" }],
            currentReasoningEffort: "high",
            supportedReasoningEfforts: ["low", "high"],
            agentVersion: "0.2.99",
          },
        ),
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
        resolvedModel: "grok-4.5",
        availableModels: [{ modelId: "grok-4.5", name: "Grok 4.5" }],
        currentReasoningEffort: "high",
        supportedReasoningEfforts: ["low", "high"],
        agentVersion: "0.2.99",
      },
    });
  });

  it("falls back to the prepared session ID", () => {
    expect(
      grokBuildProviderMetadata(
        normalizeCompletionMetadata(null, "cancelled", {
          sessionId: "session-fallback",
          resolvedModelId: "grok-4.5",
        }),
      ),
    ).toEqual({
      "grok-build": {
        sessionId: "session-fallback",
        stopReason: "cancelled",
        resolvedModel: "grok-4.5",
      },
    });
  });
});
