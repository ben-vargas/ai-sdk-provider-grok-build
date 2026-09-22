import { describe, expect, it } from "vitest";
import { AcpProtocolError } from "./errors.js";
import { validateAcpResponse } from "./validation.js";

describe("validateAcpResponse", () => {
  it("normalizes omitted initialize capabilities and authentication methods", () => {
    expect(
      validateAcpResponse("initialize", { protocolVersion: 1 }),
    ).toMatchObject({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: {},
        auth: {},
      },
      authMethods: [],
    });
  });

  it("normalizes omitted nested capabilities while rejecting malformed values", () => {
    const normalized = validateAcpResponse("initialize", {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true },
        mcpCapabilities: { sse: true },
      },
    });
    expect(normalized.agentCapabilities).toMatchObject({
      loadSession: false,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: false,
      },
      mcpCapabilities: { http: false, sse: true },
      sessionCapabilities: {},
      auth: {},
    });
    expect(() =>
      validateAcpResponse("initialize", {
        protocolVersion: 1,
        agentCapabilities: { loadSession: "yes" },
      }),
    ).toThrow(AcpProtocolError);
  });

  it("normalizes null capability fields and rejects malformed non-null fields", () => {
    expect(
      validateAcpResponse("initialize", {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: null,
          promptCapabilities: {
            image: null,
            audio: true,
            embeddedContext: null,
          },
          mcpCapabilities: null,
          sessionCapabilities: null,
          auth: null,
        },
        authMethods: null,
      }),
    ).toMatchObject({
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: true,
          embeddedContext: false,
        },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: {},
        auth: {},
      },
      authMethods: [],
    });
    expect(
      validateAcpResponse("initialize", {
        protocolVersion: 1,
        agentCapabilities: null,
        authMethods: null,
      }),
    ).toMatchObject({
      agentCapabilities: { loadSession: false },
      authMethods: [],
    });
    for (const value of [
      { agentCapabilities: { promptCapabilities: [] } },
      { agentCapabilities: { auth: [] } },
      { authMethods: {} },
    ]) {
      expect(() =>
        validateAcpResponse("initialize", {
          protocolVersion: 1,
          ...value,
        }),
      ).toThrow(AcpProtocolError);
    }
  });

  it("normalizes missing reasoning effort ids and labels to their value", () => {
    const result = validateAcpResponse("initialize", {
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok",
          availableModels: [
            {
              modelId: "grok",
              name: "Grok",
              _meta: { reasoningEfforts: [{ value: "high" }] },
            },
          ],
        },
      },
    });
    expect(
      result._meta?.modelState?.availableModels[0]?._meta?.reasoningEfforts,
    ).toEqual([{ id: "high", value: "high", label: "high" }]);
    expect(() =>
      validateAcpResponse("initialize", {
        protocolVersion: 1,
        _meta: {
          modelState: {
            currentModelId: "grok",
            availableModels: [
              {
                modelId: "grok",
                name: "Grok",
                _meta: {
                  reasoningEfforts: [{ id: "", value: "high" }],
                },
              },
            ],
          },
        },
      }),
    ).toThrow(AcpProtocolError);
  });

  it("validates authenticate terminal responses", () => {
    expect(validateAcpResponse("authenticate", {})).toEqual({});
    expect(validateAcpResponse("authenticate", null)).toEqual({});
    expect(() => validateAcpResponse("authenticate", { _meta: [] })).toThrow(
      AcpProtocolError,
    );
  });

  it("validates prompt terminal responses", () => {
    expect(
      validateAcpResponse("session/prompt", {
        stopReason: "end_turn",
        usage: {},
      }),
    ).toMatchObject({ stopReason: "end_turn" });
    for (const result of [
      null,
      {},
      { stopReason: "" },
      { stopReason: "end_turn", usage: [] },
      { stopReason: "end_turn", _meta: [] },
    ]) {
      expect(() => validateAcpResponse("session/prompt", result)).toThrow(
        AcpProtocolError,
      );
    }
  });
});
