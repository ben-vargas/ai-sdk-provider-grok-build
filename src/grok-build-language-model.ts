import { resolve } from "node:path";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4ResponseMetadata,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import { parseProviderOptions } from "@ai-sdk/provider-utils";
import { AcpClient, type AcpClientOptions } from "./acp/client.js";
import { AcpProtocolError } from "./acp/errors.js";
import type {
  AcpConfigOption,
  AcpExtensionNotification,
  AcpMcpServer,
  AcpModelState,
  AcpSessionResult,
} from "./acp/protocol.js";
import { mapAcpError, missingApiKeyError } from "./errors.js";
import { ensureGrokCliVersion, resolveGrokCommand } from "./grok-cli.js";
import { mapGrokBuildFinishReason } from "./map-finish-reason.js";
import { resolveGrokLogger } from "./logger.js";
import { mapGrokBuildCallWarnings, mapGrokBuildPrompt } from "./map-prompt.js";
import {
  normalizeAcpUsage,
  normalizeCompletionMetadata,
  type NormalizedSessionMetadata,
} from "./normalized-usage.js";
import { grokBuildProviderMetadata, mapGrokBuildUsage } from "./map-usage.js";
import { GrokBuildV4StreamEmitter } from "./map-v4-events.js";
import { redactSensitiveData } from "./redact.js";
import {
  grokBuildProviderOptionsSchema,
  type GrokBuildLogger,
  type GrokBuildProviderOptions,
  type GrokBuildSettings,
  validateGrokBuildModelId,
  validateGrokBuildSettings,
} from "./settings.js";

export type AcpClientFactory = (options: AcpClientOptions) => AcpClient;

export interface GrokBuildLanguageModelOptions {
  id: string;
  settings?: GrokBuildSettings;
  clientFactory?: AcpClientFactory;
  /** Internal: pooled providers retain clients after each call. */
  disposeClient?: boolean;
  /** Internal: custom factories can opt into real CLI resolution/version checks. */
  validateCli?: boolean;
}

interface PreparedCall {
  client: AcpClient;
  releaseClientLease(): void;
  sessionId: string;
  prompt: Awaited<ReturnType<typeof mapGrokBuildPrompt>>["prompt"];
  warnings: SharedV4Warning[];
  includeRawChunks: boolean;
  extensionEvents: AcpExtensionNotification[];
  attachExtensionConsumer(
    consumer: (event: AcpExtensionNotification) => void,
  ): () => void;
  promptTimeoutMs?: number;
  resolvedModelId: string;
  sessionMetadata: NormalizedSessionMetadata;
  disposeClient: boolean;
}

function mergeMcpServers(
  defaults: AcpMcpServer[] | undefined,
  overrides: AcpMcpServer[] | undefined,
): AcpMcpServer[] {
  const merged = new Map<string, AcpMcpServer>();
  for (const server of defaults ?? []) merged.set(server.name, server);
  for (const server of overrides ?? []) merged.set(server.name, server);
  return [...merged.values()];
}

function currentReasoningEffort(
  models: AcpModelState | undefined,
): string | undefined {
  return models?.availableModels.find(
    (model) => model.modelId === models.currentModelId,
  )?._meta?.reasoningEffort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function malformedAcpPayload(source: string, value: unknown): never {
  throw new AcpProtocolError(`Grok returned malformed ${source}.`, {
    data: redactSensitiveData(value),
  });
}

function validateModelState(
  value: unknown,
  source: string,
): AcpModelState | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.currentModelId !== "string" ||
    value.currentModelId.trim().length === 0 ||
    !Array.isArray(value.availableModels)
  ) {
    return malformedAcpPayload(source, value);
  }
  for (const model of value.availableModels) {
    if (
      !isRecord(model) ||
      typeof model.modelId !== "string" ||
      model.modelId.trim().length === 0 ||
      typeof model.name !== "string" ||
      model.name.trim().length === 0
    ) {
      return malformedAcpPayload(source, value);
    }
  }
  return value as unknown as AcpModelState;
}

function validateConfigOptions(
  value: unknown,
  source: string,
  required = false,
): AcpConfigOption[] | undefined {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value)) return malformedAcpPayload(source, value);
  for (const option of value) {
    if (
      !isRecord(option) ||
      typeof option.id !== "string" ||
      option.id.trim().length === 0 ||
      typeof option.type !== "string" ||
      option.type.trim().length === 0 ||
      (Object.hasOwn(option, "currentValue") &&
        (typeof option.currentValue !== "string" ||
          option.currentValue.trim().length === 0))
    ) {
      return malformedAcpPayload(source, value);
    }
    const choices = option.options;
    if (choices !== undefined && !Array.isArray(choices)) {
      return malformedAcpPayload(source, value);
    }
    for (const choice of choices ?? []) {
      if (
        !isRecord(choice) ||
        typeof choice.value !== "string" ||
        choice.value.trim().length === 0
      ) {
        return malformedAcpPayload(source, value);
      }
    }
  }
  return value as AcpConfigOption[];
}

function requestedReasoningEffort(
  options: LanguageModelV4CallOptions,
  providerOptions: GrokBuildProviderOptions | undefined,
): string | undefined {
  if (providerOptions?.reasoningEffort) return providerOptions.reasoningEffort;
  return options.reasoning && options.reasoning !== "provider-default"
    ? options.reasoning
    : undefined;
}

function configOption(
  options: AcpConfigOption[] | undefined,
  id: string,
): AcpConfigOption | undefined {
  return options?.find((option) => option.id === id);
}

function configChoiceValues(option: AcpConfigOption | undefined): string[] {
  return option?.options?.map((choice) => choice.value) ?? [];
}

export function buildAcpCommandArgs(
  prefixArgs: readonly string[],
  options: {
    permissionMode: string;
    dangerouslySkipPermissions: boolean;
    alwaysApprove: boolean;
    xaiApiBaseUrl?: string;
  },
): string[] {
  return [
    ...prefixArgs,
    "--no-auto-update",
    ...(options.dangerouslySkipPermissions
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", options.permissionMode]),
    "agent",
    ...(options.alwaysApprove && !options.dangerouslySkipPermissions
      ? ["--always-approve"]
      : []),
    ...(options.xaiApiBaseUrl
      ? ["--xai-api-base-url", options.xaiApiBaseUrl]
      : []),
    "stdio",
  ];
}

function sessionResultModels(
  result: AcpSessionResult | null | Record<string, never>,
): AcpModelState | undefined {
  return result && "models" in result
    ? validateModelState(result.models, "session/load model state")
    : undefined;
}

function sessionResultConfigOptions(
  result: AcpSessionResult | null | Record<string, never>,
): AcpConfigOption[] | undefined {
  return result && "configOptions" in result
    ? validateConfigOptions(result.configOptions, "session/load config options")
    : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The Grok Build call was aborted.");
  error.name = "AbortError";
  throw error;
}

export class GrokBuildLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "grok-build";
  readonly supportedUrls = {};
  readonly modelId: string;

  private readonly settings: GrokBuildSettings;
  private readonly logger: GrokBuildLogger;
  private readonly clientFactory: AcpClientFactory;
  private readonly disposeClient: boolean;
  private readonly validateCli: boolean;

  constructor(options: GrokBuildLanguageModelOptions) {
    this.modelId = validateGrokBuildModelId(options.id);
    this.settings = validateGrokBuildSettings(options.settings ?? {});
    this.logger = resolveGrokLogger(
      this.settings.logger,
      this.settings.verbose,
    );
    this.disposeClient = options.disposeClient ?? true;
    this.validateCli =
      options.validateCli ?? options.clientFactory === undefined;
    this.clientFactory =
      options.clientFactory ??
      ((clientOptions) => new AcpClient(clientOptions));
  }

  async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    const { stream } = await this.doStream(options);
    const content: LanguageModelV4Content[] = [];
    const contentIndexes = new Map<string, number>();
    const toolResultIndexes = new Map<string, number>();
    let warnings: SharedV4Warning[] = [];
    let finishReason: LanguageModelV4GenerateResult["finishReason"] | undefined;
    let usage: LanguageModelV4GenerateResult["usage"] | undefined;
    let metadata: SharedV4ProviderMetadata | undefined;
    let response: LanguageModelV4ResponseMetadata | undefined;

    for await (const part of stream) {
      switch (part.type) {
        case "stream-start":
          warnings = part.warnings;
          break;
        case "response-metadata":
          response = {
            id: part.id,
            timestamp: part.timestamp,
            modelId: part.modelId,
          };
          break;
        case "text-start":
          contentIndexes.set(part.id, content.length);
          content.push({
            type: "text",
            text: "",
            providerMetadata: part.providerMetadata,
          });
          break;
        case "text-delta": {
          const index = contentIndexes.get(part.id);
          const existing = index === undefined ? undefined : content[index];
          if (index !== undefined && existing?.type === "text") {
            content[index] = { ...existing, text: existing.text + part.delta };
          }
          break;
        }
        case "reasoning-start":
          contentIndexes.set(part.id, content.length);
          content.push({
            type: "reasoning",
            text: "",
            providerMetadata: part.providerMetadata,
          });
          break;
        case "reasoning-delta": {
          const index = contentIndexes.get(part.id);
          const existing = index === undefined ? undefined : content[index];
          if (index !== undefined && existing?.type === "reasoning") {
            content[index] = { ...existing, text: existing.text + part.delta };
          }
          break;
        }
        case "tool-call":
        case "tool-approval-request":
        case "custom":
        case "file":
        case "reasoning-file":
        case "source":
          content.push(part);
          break;
        case "tool-result": {
          const previousIndex = toolResultIndexes.get(part.toolCallId);
          const previous =
            previousIndex === undefined ? undefined : content[previousIndex];
          if (previousIndex === undefined) {
            toolResultIndexes.set(part.toolCallId, content.length);
            content.push(part);
          } else if (
            previous?.type === "tool-result" &&
            previous.preliminary === true
          ) {
            content[previousIndex] = part;
          }
          break;
        }
        case "finish":
          finishReason = part.finishReason;
          usage = part.usage;
          metadata = part.providerMetadata;
          break;
        case "error":
          throw part.error;
        default:
          break;
      }
    }

    if (!finishReason || !usage) {
      throw new APICallError({
        message: "Grok ACP stream ended without a terminal finish record.",
        url: "grok-build://acp",
        requestBodyValues: undefined,
        isRetryable: false,
      });
    }

    return {
      content,
      finishReason,
      usage,
      warnings,
      providerMetadata: metadata,
      response,
    };
  }

  async doStream(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    const abortController = new AbortController();
    const forwardAbort = (): void =>
      abortController.abort(options.abortSignal?.reason);
    if (options.abortSignal?.aborted) forwardAbort();
    else
      options.abortSignal?.addEventListener("abort", forwardAbort, {
        once: true,
      });

    let prepared: PreparedCall;
    try {
      throwIfAborted(abortController.signal);
      prepared = await this.prepareCall(options, abortController.signal);
    } catch (error) {
      options.abortSignal?.removeEventListener("abort", forwardAbort);
      throw mapAcpError(error, { modelId: this.modelId });
    }

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: (controller) => {
        const emitter = new GrokBuildV4StreamEmitter(
          controller,
          prepared.includeRawChunks,
          (warning) =>
            this.logger.warn(
              warning.type === "compatibility"
                ? (warning.details ?? warning.feature)
                : "ACP compatibility warning",
            ),
        );
        emitter.emitStart(prepared.warnings, prepared.resolvedModelId);
        for (const event of prepared.extensionEvents)
          emitter.emitExtension(event);
        const detachExtensionConsumer = prepared.attachExtensionConsumer(
          (event) => emitter.emitExtension(event),
        );

        void prepared.client
          .prompt(
            {
              sessionId: prepared.sessionId,
              prompt:
                prepared.prompt.length > 0
                  ? prepared.prompt
                  : [{ type: "text", text: "" }],
            },
            {
              signal: abortController.signal,
              timeoutMs: prepared.promptTimeoutMs,
              onUpdate: (update) => {
                try {
                  emitter.emitUpdate(update);
                } catch (error) {
                  if (!abortController.signal.aborted) {
                    abortController.abort(error);
                  }
                }
              },
            },
          )
          .then((outcome) => {
            emitter.emitFinish(
              mapGrokBuildFinishReason(outcome.stopReason),
              mapGrokBuildUsage(normalizeAcpUsage(outcome.meta)),
              grokBuildProviderMetadata(
                normalizeCompletionMetadata(
                  outcome.meta,
                  outcome.stopReason,
                  prepared.sessionMetadata,
                ),
              ),
            );
            emitter.close();
          })
          .catch((error: unknown) => {
            emitter.error(
              mapAcpError(
                error,
                { modelId: this.modelId },
                { postDispatch: true },
              ),
            );
          })
          .finally(async () => {
            options.abortSignal?.removeEventListener("abort", forwardAbort);
            detachExtensionConsumer();
            try {
              if (prepared.disposeClient) await prepared.client.dispose();
            } finally {
              prepared.releaseClientLease();
            }
          });
      },
      cancel: (reason) => {
        abortController.abort(reason);
      },
    });

    return { stream };
  }

  private async prepareCall(
    options: LanguageModelV4CallOptions,
    signal: AbortSignal,
  ): Promise<PreparedCall> {
    throwIfAborted(signal);
    const mappedPrompt = await mapGrokBuildPrompt(
      options.prompt,
      options.responseFormat,
    );
    throwIfAborted(signal);
    const warnings = [
      ...mapGrokBuildCallWarnings(options),
      ...mappedPrompt.warnings,
    ];
    const providerOptions =
      await parseProviderOptions<GrokBuildProviderOptions>({
        provider: this.provider,
        providerOptions: options.providerOptions,
        schema: grokBuildProviderOptionsSchema,
      });
    throwIfAborted(signal);

    if (providerOptions?.maxTurns !== undefined) {
      warnings.push({
        type: "unsupported",
        feature: "maxTurns",
        details:
          "ACP exposes max_turn_requests only as a stop reason, not an enforceable prompt input; maxTurns was ignored.",
      });
    }
    if (providerOptions?.session?.continue) {
      warnings.push({
        type: "unsupported",
        feature: "session.continue",
        details:
          "ACP exposes no verified most-recent-session lookup; a new session is used unless an explicit session ID is supplied.",
      });
    }
    if (providerOptions?.session?.fork) {
      warnings.push({
        type: "unsupported",
        feature: "session.fork",
        details:
          "ACP does not advertise a fork operation; a new session is created instead of mutating the source session.",
      });
    }

    const extensionEvents: AcpExtensionNotification[] = [];
    const includeRawChunks = Boolean(
      this.settings.includeRawChunks || options.includeRawChunks,
    );
    const includeExtensionEvents = Boolean(
      providerOptions?.includeExtensionEvents,
    );
    const authMethod =
      this.settings.authMethod ??
      (this.settings.apiKey ? "api_key" : "cached_token");
    const env = {
      ...this.settings.env,
      ...(this.settings.apiKey ? { XAI_API_KEY: this.settings.apiKey } : {}),
      ...(this.settings.xaiApiBaseUrl
        ? { XAI_API_BASE_URL: this.settings.xaiApiBaseUrl }
        : {}),
    };
    if (authMethod === "api_key") {
      const apiKey = env.XAI_API_KEY ?? process.env.XAI_API_KEY;
      if (!apiKey) throw missingApiKeyError();
      env.XAI_API_KEY = apiKey;
    }

    const resolvedCommand = this.validateCli
      ? await resolveGrokCommand({
          executablePath: this.settings.executablePath,
          allowPackageBin: this.settings.allowPackageBin,
          allowNpx: this.settings.allowNpx,
          cwd: this.settings.cwd,
          env,
        })
      : undefined;
    if (resolvedCommand) {
      await ensureGrokCliVersion(resolvedCommand, {
        cwd: this.settings.cwd,
        env,
        signal,
      });
    }
    const permissionMode =
      providerOptions?.dangerouslySkipPermissions ||
      this.settings.dangerouslySkipPermissions
        ? "bypassPermissions"
        : (providerOptions?.permissionMode ??
          this.settings.permissionMode ??
          "default");
    const alwaysApprove =
      providerOptions?.alwaysApprove ?? this.settings.alwaysApprove;
    const dangerouslySkipPermissions = Boolean(
      this.settings.dangerouslySkipPermissions ||
      providerOptions?.dangerouslySkipPermissions,
    );
    const args = buildAcpCommandArgs(resolvedCommand?.prefixArgs ?? [], {
      permissionMode,
      dangerouslySkipPermissions,
      alwaysApprove: Boolean(alwaysApprove),
      xaiApiBaseUrl: this.settings.xaiApiBaseUrl,
    });
    const client = this.clientFactory({
      executable: resolvedCommand?.command ?? this.settings.executablePath,
      args,
      cwd: this.settings.cwd,
      env,
      authMethod: authMethod === "api_key" ? false : authMethod,
      permissionMode,
      alwaysApprove,
      onPermissionRequest: this.settings.onPermissionRequest,
      fileSystem: this.settings.fileSystem,
      requestTimeoutMs: this.settings.timeouts?.requestMs,
      cancelGraceMs: this.settings.timeouts?.cancelGraceMs,
      terminateGraceMs: this.settings.timeouts?.terminateGraceMs,
      killGraceMs: this.settings.timeouts?.killGraceMs,
    });
    const releaseClientLease = client.acquireLease();
    let extensionConsumer:
      | ((event: AcpExtensionNotification) => void)
      | undefined;
    let activeSessionId: string | undefined;
    let unregisterExtension = (): void => undefined;
    const handleExtension = (event: AcpExtensionNotification): void => {
      if (!includeRawChunks && !includeExtensionEvents) return;
      const params =
        event.params && typeof event.params === "object"
          ? (event.params as Record<string, unknown>)
          : undefined;
      const meta =
        params?._meta &&
        typeof params._meta === "object" &&
        !Array.isArray(params._meta)
          ? (params._meta as Record<string, unknown>)
          : undefined;
      if (meta?.isReplay === true) return;
      if (
        activeSessionId !== undefined &&
        typeof params?.sessionId === "string" &&
        params.sessionId !== activeSessionId
      ) {
        return;
      }
      if (extensionConsumer) extensionConsumer(event);
      else extensionEvents.push(event);
    };
    unregisterExtension = client.registerExtensionHandler(handleExtension);

    const discardOtherSessionExtensions = (): void => {
      if (activeSessionId === undefined) return;
      for (let index = extensionEvents.length - 1; index >= 0; index--) {
        const params = extensionEvents[index]?.params;
        if (
          params &&
          typeof params === "object" &&
          typeof (params as Record<string, unknown>).sessionId === "string" &&
          (params as Record<string, unknown>).sessionId !== activeSessionId
        ) {
          extensionEvents.splice(index, 1);
        }
      }
    };

    try {
      const initialized = await client.initialize(signal);
      const initializeModels = validateModelState(
        initialized._meta?.modelState,
        "initialize model state",
      );
      const cwd = resolve(this.settings.cwd ?? process.cwd());
      const mcpServers = mergeMcpServers(
        this.settings.mcpServers,
        providerOptions?.mcpServers,
      );
      const sourceSessionId =
        providerOptions?.session?.id ?? providerOptions?.session?.resume;
      const shouldLoad = Boolean(
        sourceSessionId && !providerOptions?.session?.fork,
      );
      let sessionId: string;
      let models: AcpModelState | undefined;
      let configOptions: AcpConfigOption[] | undefined;

      if (shouldLoad && sourceSessionId) {
        const result = await client.loadSession(
          {
            sessionId: sourceSessionId,
            cwd,
            mcpServers,
          },
          signal,
        );
        sessionId = sourceSessionId;
        activeSessionId = sessionId;
        models = sessionResultModels(result);
        configOptions = sessionResultConfigOptions(result);
        warnings.push({
          type: "compatibility",
          feature: "session load",
          details:
            "session/load restart replay is fixture-verified, but invalid-ID, cross-CWD, and concurrent-prompt behavior are not.",
        });
      } else {
        const result = await client.newSession({ cwd, mcpServers }, signal);
        sessionId = result.sessionId;
        activeSessionId = sessionId;
        models = validateModelState(result.models, "session/new model state");
        configOptions = validateConfigOptions(
          result.configOptions,
          "session/new config options",
        );
      }
      discardOtherSessionExtensions();
      models ??= initializeModels;

      const requestedModel = providerOptions?.model ?? this.modelId;
      if (requestedModel !== "default") {
        const modelOption = configOption(configOptions, "model");
        const choices = configChoiceValues(modelOption);
        if (
          modelOption &&
          choices.length > 0 &&
          !choices.includes(requestedModel)
        ) {
          warnings.push({
            type: "unsupported",
            feature: "model selection",
            details: `Requested model '${requestedModel}' is not present in Grok's advertised session model choices.`,
          });
        } else if (modelOption) {
          const updated = await client.setConfigOption(
            { sessionId, configId: "model", value: requestedModel },
            signal,
          );
          configOptions = validateConfigOptions(
            updated.configOptions,
            "session/set_config_option config options",
            true,
          );
          if (
            configOption(configOptions, "model")?.currentValue !==
            requestedModel
          ) {
            throw new AcpProtocolError(
              `Grok did not apply requested session model '${requestedModel}'.`,
              { code: "CONFIG_OPTION_NOT_APPLIED" },
            );
          }
        }
      }

      const effort =
        requestedReasoningEffort(options, providerOptions) ??
        this.settings.reasoningEffort;
      if (effort) {
        const effortOption = configOption(configOptions, "reasoning_effort");
        const choices = configChoiceValues(effortOption);
        if (effortOption && choices.length > 0 && !choices.includes(effort)) {
          warnings.push({
            type: "unsupported",
            feature: "reasoning",
            details: `Grok does not advertise reasoning effort '${effort}' for this session.`,
          });
        } else if (effortOption) {
          const updated = await client.setConfigOption(
            { sessionId, configId: "reasoning_effort", value: effort },
            signal,
          );
          configOptions = validateConfigOptions(
            updated.configOptions,
            "session/set_config_option config options",
            true,
          );
          if (
            configOption(configOptions, "reasoning_effort")?.currentValue !==
            effort
          ) {
            throw new AcpProtocolError(
              `Grok did not apply requested reasoning effort '${effort}'.`,
              { code: "CONFIG_OPTION_NOT_APPLIED" },
            );
          }
        } else if (currentReasoningEffort(models) !== effort) {
          warnings.push({
            type: "compatibility",
            feature: "reasoning",
            details: `Requested reasoning effort '${effort}', but Grok did not advertise a session reasoning config option.`,
          });
        }
      }

      const selectedModel = configOption(configOptions, "model")?.currentValue;
      const resolvedModelId =
        selectedModel ?? models?.currentModelId ?? requestedModel;
      const requestedModelAvailable = models?.availableModels.some(
        (model) => model.modelId === requestedModel,
      );
      if (
        requestedModel !== "default" &&
        !configOption(configOptions, "model") &&
        models &&
        !requestedModelAvailable
      ) {
        warnings.push({
          type: "unsupported",
          feature: "model selection",
          details: `Requested model '${requestedModel}' is not present in Grok's advertised model catalog; ACP resolved '${resolvedModelId}'.`,
        });
      } else if (
        requestedModel !== "default" &&
        requestedModel !== resolvedModelId &&
        !configOption(configOptions, "model")
      ) {
        warnings.push({
          type: "compatibility",
          feature: "model selection",
          details: `Requested model '${requestedModel}', but ACP did not advertise a model config option and resolved '${resolvedModelId}'.`,
        });
      }

      this.logger.debug(
        `Grok ACP session ${sessionId} prepared with model ${resolvedModelId}.`,
      );
      const currentEffort =
        configOption(configOptions, "reasoning_effort")?.currentValue ??
        currentReasoningEffort(models);
      const supportedEfforts =
        configOption(configOptions, "reasoning_effort")?.options?.map(
          (item) => item.value,
        ) ??
        models?.availableModels
          .find((model) => model.modelId === resolvedModelId)
          ?._meta?.reasoningEfforts?.map((item) => item.value);
      return {
        client,
        releaseClientLease,
        sessionId,
        prompt: mappedPrompt.prompt,
        warnings,
        includeRawChunks,
        extensionEvents,
        attachExtensionConsumer: (consumer) => {
          extensionConsumer = consumer;
          return unregisterExtension;
        },
        promptTimeoutMs: this.settings.timeouts?.promptMs,
        resolvedModelId,
        sessionMetadata: {
          sessionId,
          resolvedModelId,
          availableModels: models?.availableModels,
          currentReasoningEffort: currentEffort,
          supportedReasoningEfforts: supportedEfforts,
          agentVersion:
            initialized._meta?.agentVersion ?? initialized.agentInfo?.version,
        },
        disposeClient: this.disposeClient,
      };
    } catch (error) {
      unregisterExtension();
      try {
        if (this.disposeClient || !client.isUsable) await client.dispose();
        throw error;
      } finally {
        releaseClientLease();
      }
    }
  }
}
