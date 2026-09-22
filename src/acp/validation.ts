import { isRecord } from "../type-guards.js";
import { AcpProtocolError } from "./errors.js";
import type {
  AcpAgentCapabilities,
  AcpAuthenticateResult,
  AcpAuthMethod,
  AcpConfigBooleanOption,
  AcpConfigOption,
  AcpConfigSelectChoice,
  AcpConfigSelectGroup,
  AcpConfigSelectOption,
  AcpImplementation,
  AcpInitializeResult,
  AcpInitializeResultMeta,
  AcpLoadSessionResult,
  AcpModelInfo,
  AcpModelState,
  AcpPromptResult,
  AcpReasoningEffort,
  AcpRequestMap,
  AcpSessionResult,
  AcpSessionState,
  AcpSetConfigOptionResult,
  JsonValue,
} from "./protocol.js";

function malformed(source: string, value: unknown): never {
  throw new AcpProtocolError(`Grok returned malformed ${source}.`, {
    data: value as JsonValue,
  });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function optionalMeta(value: unknown): boolean {
  return value === undefined || value === null || isRecord(value);
}

function validateReasoningEffort(
  value: unknown,
  source: string,
): AcpReasoningEffort {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.value) ||
    (value.id !== undefined && !nonEmptyString(value.id)) ||
    (value.label !== undefined && !nonEmptyString(value.label)) ||
    !optionalString(value.description) ||
    (value.default !== undefined && typeof value.default !== "boolean")
  ) {
    return malformed(source, value);
  }
  return {
    ...value,
    id: value.id ?? value.value,
    value: value.value,
    label: value.label ?? value.value,
  } as AcpReasoningEffort;
}

function validateModelInfo(value: unknown, source: string): AcpModelInfo {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.modelId) ||
    !nonEmptyString(value.name) ||
    !optionalString(value.description) ||
    !optionalMeta(value._meta)
  ) {
    return malformed(source, value);
  }

  if (!isRecord(value._meta)) return value as unknown as AcpModelInfo;
  const meta = { ...value._meta };
  if (
    meta.reasoningEffort !== undefined &&
    meta.reasoningEffort !== null &&
    !nonEmptyString(meta.reasoningEffort)
  ) {
    return malformed(source, value);
  }
  if (
    meta.reasoningEfforts !== undefined &&
    meta.reasoningEfforts !== null &&
    !Array.isArray(meta.reasoningEfforts)
  ) {
    return malformed(source, value);
  }
  if (Array.isArray(meta.reasoningEfforts)) {
    meta.reasoningEfforts = meta.reasoningEfforts.map((effort, index) =>
      validateReasoningEffort(
        effort,
        `${source} reasoning effort at index ${String(index)}`,
      ),
    );
  } else {
    delete meta.reasoningEfforts;
  }
  if (meta.reasoningEffort === null) delete meta.reasoningEffort;
  return { ...value, _meta: meta } as unknown as AcpModelInfo;
}

export function validateModelState(
  value: unknown,
  source: string,
): AcpModelState | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !isRecord(value) ||
    !nonEmptyString(value.currentModelId) ||
    !Array.isArray(value.availableModels)
  ) {
    return malformed(source, value);
  }
  return {
    ...value,
    currentModelId: value.currentModelId,
    availableModels: value.availableModels.map((model, index) =>
      validateModelInfo(model, `${source} model at index ${String(index)}`),
    ),
  } as AcpModelState;
}

function validateSelectChoice(
  value: unknown,
  source: string,
): AcpConfigSelectChoice {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.value) ||
    !nonEmptyString(value.name) ||
    !optionalString(value.description) ||
    !optionalMeta(value._meta)
  ) {
    return malformed(source, value);
  }
  return value as unknown as AcpConfigSelectChoice;
}

function validateSelectGroup(
  value: unknown,
  source: string,
): AcpConfigSelectGroup {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.group) ||
    !nonEmptyString(value.name) ||
    !Array.isArray(value.options) ||
    !optionalMeta(value._meta)
  ) {
    return malformed(source, value);
  }
  return {
    ...value,
    group: value.group,
    name: value.name,
    options: value.options.map((choice, index) =>
      validateSelectChoice(
        choice,
        `${source} choice at index ${String(index)}`,
      ),
    ),
  } as AcpConfigSelectGroup;
}

function validateConfigOption(value: unknown, source: string): AcpConfigOption {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.name) ||
    !nonEmptyString(value.type) ||
    !optionalString(value.description) ||
    !optionalString(value.category) ||
    !optionalMeta(value._meta)
  ) {
    return malformed(source, value);
  }

  if (value.type === "boolean") {
    if (typeof value.currentValue !== "boolean") {
      return malformed(source, value);
    }
    return value as unknown as AcpConfigBooleanOption;
  }
  if (value.type !== "select") {
    return value as unknown as AcpConfigOption;
  }
  if (!nonEmptyString(value.currentValue) || !Array.isArray(value.options)) {
    return malformed(source, value);
  }

  const grouped = value.options.some(
    (option) => isRecord(option) && Object.hasOwn(option, "group"),
  );
  const options = grouped
    ? value.options.map((group, index) =>
        validateSelectGroup(group, `${source} group at index ${String(index)}`),
      )
    : value.options.map((choice, index) =>
        validateSelectChoice(
          choice,
          `${source} choice at index ${String(index)}`,
        ),
      );
  return { ...value, options } as AcpConfigSelectOption;
}

export function validateConfigOptions(
  value: unknown,
  source: string,
  required = false,
): AcpConfigOption[] | undefined {
  if ((value === undefined || value === null) && !required) return undefined;
  if (!Array.isArray(value)) return malformed(source, value);
  return value.map((option, index) =>
    validateConfigOption(option, `${source} option at index ${String(index)}`),
  );
}

function validateImplementation(
  value: unknown,
  source: string,
): AcpImplementation | null | undefined {
  if (value === undefined || value === null) return value;
  if (
    !isRecord(value) ||
    !nonEmptyString(value.name) ||
    !nonEmptyString(value.version) ||
    !optionalString(value.title) ||
    !optionalMeta(value._meta)
  ) {
    return malformed(source, value);
  }
  return value as unknown as AcpImplementation;
}

function validateAuthMethods(value: unknown, source: string): AcpAuthMethod[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return malformed(source, value);
  return value.map((method, index) => {
    if (
      !isRecord(method) ||
      !nonEmptyString(method.id) ||
      !nonEmptyString(method.name) ||
      !optionalString(method.description) ||
      !optionalMeta(method._meta)
    ) {
      return malformed(`${source} at index ${String(index)}`, method);
    }
    return method as unknown as AcpAuthMethod;
  });
}

function validateAgentCapabilities(
  value: unknown,
  source: string,
): AcpAgentCapabilities {
  if (value === undefined || value === null) {
    return {
      loadSession: false,
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: false,
      },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: {},
      auth: {},
    };
  }
  if (
    !isRecord(value) ||
    (value.loadSession !== undefined &&
      value.loadSession !== null &&
      typeof value.loadSession !== "boolean") ||
    !optionalMeta(value._meta)
  ) {
    return malformed(source, value);
  }

  const promptCapabilities = validateBooleanCapabilities(
    value.promptCapabilities,
    ["image", "audio", "embeddedContext"],
    `${source} prompt capabilities`,
  );
  const mcpCapabilities = validateBooleanCapabilities(
    value.mcpCapabilities,
    ["http", "sse"],
    `${source} MCP capabilities`,
  );
  const sessionCapabilities = validateRecordCapability(
    value.sessionCapabilities,
    `${source} session capabilities`,
  );
  const auth = validateRecordCapability(
    value.auth,
    `${source} authentication capabilities`,
  );
  return {
    ...value,
    loadSession: value.loadSession === true,
    promptCapabilities,
    mcpCapabilities,
    sessionCapabilities,
    auth,
  } as AcpAgentCapabilities;
}

function validateBooleanCapabilities<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
  source: string,
): Record<Key, boolean> {
  if (value === undefined || value === null) {
    return Object.fromEntries(keys.map((key) => [key, false])) as Record<
      Key,
      boolean
    >;
  }
  if (!isRecord(value)) return malformed(source, value);
  const normalized = { ...value } as Record<string, unknown>;
  for (const key of keys) {
    if (
      value[key] !== undefined &&
      value[key] !== null &&
      typeof value[key] !== "boolean"
    ) {
      return malformed(source, value);
    }
    normalized[key] = value[key] === true;
  }
  return normalized as Record<Key, boolean>;
}

function validateRecordCapability(
  value: unknown,
  source: string,
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return malformed(source, value);
  return value;
}

function validateInitializeResult(value: unknown): AcpInitializeResult {
  if (!isRecord(value) || typeof value.protocolVersion !== "number") {
    return malformed("initialize result", value);
  }
  const agentCapabilities = validateAgentCapabilities(
    value.agentCapabilities,
    "initialize agent capabilities",
  );
  const authMethods = validateAuthMethods(
    value.authMethods,
    "initialize authentication methods",
  );
  const agentInfo = validateImplementation(
    value.agentInfo,
    "initialize agent info",
  );
  if (!optionalMeta(value._meta)) {
    return malformed("initialize metadata", value._meta);
  }
  let meta: AcpInitializeResultMeta | null | undefined;
  if (isRecord(value._meta)) {
    meta = { ...value._meta } as AcpInitializeResultMeta;
  } else {
    meta = value._meta as null | undefined;
  }
  if (meta) {
    const modelState = validateModelState(
      meta.modelState,
      "initialize model state",
    );
    if (modelState) meta.modelState = modelState;
    else delete meta.modelState;
  }
  return {
    ...value,
    protocolVersion: value.protocolVersion,
    agentCapabilities,
    authMethods,
    agentInfo,
    _meta: meta,
  } as AcpInitializeResult;
}

function validateSessionResult(
  value: unknown,
  source: string,
  sessionIdRequired: true,
): AcpSessionResult;
function validateSessionResult(
  value: unknown,
  source: string,
  sessionIdRequired: false,
): AcpSessionState;
function validateSessionResult(
  value: unknown,
  source: string,
  sessionIdRequired: boolean,
): AcpSessionResult | AcpSessionState {
  if (!isRecord(value)) return malformed(source, value);
  if (
    sessionIdRequired &&
    (!nonEmptyString(value.sessionId) || !optionalMeta(value._meta))
  ) {
    return malformed(source, value);
  }
  if (
    !sessionIdRequired &&
    value.sessionId !== undefined &&
    !nonEmptyString(value.sessionId)
  ) {
    return malformed(source, value);
  }
  if (!optionalMeta(value._meta)) return malformed(source, value);

  const models = validateModelState(value.models, `${source} model state`);
  const configOptions = validateConfigOptions(
    value.configOptions,
    `${source} config options`,
  );
  const normalized = { ...value };
  if (models) normalized.models = models;
  else delete normalized.models;
  if (configOptions) normalized.configOptions = configOptions;
  else delete normalized.configOptions;
  return normalized as unknown as AcpSessionResult | AcpSessionState;
}

function validateLoadSessionResult(value: unknown): AcpLoadSessionResult {
  if (value === null) return null;
  return validateSessionResult(value, "session/load result", false);
}

function validateSetConfigOptionResult(
  value: unknown,
): AcpSetConfigOptionResult {
  if (!isRecord(value) || !optionalMeta(value._meta)) {
    return malformed("session/set_config_option result", value);
  }
  return {
    ...value,
    configOptions: validateConfigOptions(
      value.configOptions,
      "session/set_config_option config options",
      true,
    ),
  } as AcpSetConfigOptionResult;
}

function validateAuthenticateResult(value: unknown): AcpAuthenticateResult {
  if (value === null) return {};
  if (!isRecord(value) || !optionalMeta(value._meta)) {
    return malformed("authenticate result", value);
  }
  return value as AcpAuthenticateResult;
}

function validatePromptResult(value: unknown): AcpPromptResult {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.stopReason) ||
    !optionalString(value.userMessageId) ||
    !optionalMeta(value._meta) ||
    (value.usage !== undefined &&
      value.usage !== null &&
      !isRecord(value.usage))
  ) {
    return malformed("session/prompt result", value);
  }
  return value as unknown as AcpPromptResult;
}

export function validateAcpResponse<Method extends keyof AcpRequestMap>(
  method: Method,
  value: unknown,
): AcpRequestMap[Method]["result"] {
  switch (method) {
    case "initialize":
      return validateInitializeResult(value) as AcpRequestMap[Method]["result"];
    case "authenticate":
      return validateAuthenticateResult(
        value,
      ) as AcpRequestMap[Method]["result"];
    case "session/new":
      return validateSessionResult(
        value,
        "session/new result",
        true,
      ) as AcpRequestMap[Method]["result"];
    case "session/load":
      return validateLoadSessionResult(
        value,
      ) as AcpRequestMap[Method]["result"];
    case "session/prompt":
      return validatePromptResult(value) as AcpRequestMap[Method]["result"];
    case "session/set_config_option":
      return validateSetConfigOptionResult(
        value,
      ) as AcpRequestMap[Method]["result"];
    default:
      return value as AcpRequestMap[Method]["result"];
  }
}
