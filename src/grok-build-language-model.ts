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
import type {
  AcpExtensionNotification,
  AcpMcpServer,
  AcpModelState,
  AcpSessionResult,
} from "./acp/protocol.js";
import { mapAcpError, missingApiKeyError } from "./errors.js";
import { mapGrokBuildFinishReason } from "./map-finish-reason.js";
import { mapGrokBuildCallWarnings, mapGrokBuildPrompt } from "./map-prompt.js";
import {
  normalizeAcpUsage,
  normalizeCompletionMetadata,
  type NormalizedSessionMetadata,
} from "./normalized-usage.js";
import { grokBuildProviderMetadata, mapGrokBuildUsage } from "./map-usage.js";
import { GrokBuildV4StreamEmitter } from "./map-v4-events.js";
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
}

interface PreparedCall {
  client: AcpClient;
  sessionId: string;
  prompt: Awaited<ReturnType<typeof mapGrokBuildPrompt>>["prompt"];
  warnings: SharedV4Warning[];
  includeRawChunks: boolean;
  extensionEvents: AcpExtensionNotification[];
  attachExtensionConsumer(
    consumer: (event: AcpExtensionNotification) => void,
  ): void;
  promptTimeoutMs?: number;
  resolvedModelId: string;
  sessionMetadata: NormalizedSessionMetadata;
}

const noopLogger: GrokBuildLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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

function requestedReasoningEffort(
  options: LanguageModelV4CallOptions,
  providerOptions: GrokBuildProviderOptions | undefined,
): string | undefined {
  if (providerOptions?.reasoningEffort) return providerOptions.reasoningEffort;
  return options.reasoning && options.reasoning !== "provider-default"
    ? options.reasoning
    : undefined;
}

function sessionResultModels(
  result: AcpSessionResult | null | Record<string, never>,
): AcpModelState | undefined {
  return result && "models" in result && result.models
    ? result.models
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

  constructor(options: GrokBuildLanguageModelOptions) {
    this.modelId = validateGrokBuildModelId(options.id);
    this.settings = validateGrokBuildSettings(options.settings ?? {});
    this.logger = this.settings.logger ?? noopLogger;
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
        isRetryable: true,
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
        prepared.attachExtensionConsumer((event) =>
          emitter.emitExtension(event),
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
              onUpdate: (update) => emitter.emitUpdate(update),
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
            emitter.error(mapAcpError(error, { modelId: this.modelId }));
          })
          .finally(async () => {
            options.abortSignal?.removeEventListener("abort", forwardAbort);
            await prepared.client.dispose();
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
    let extensionConsumer:
      | ((event: AcpExtensionNotification) => void)
      | undefined;
    const includeRawChunks = Boolean(
      this.settings.includeRawChunks || options.includeRawChunks,
    );
    const includeExtensionEvents = Boolean(
      providerOptions?.includeExtensionEvents,
    );
    const authMethod = this.settings.authMethod ?? "cached_token";
    const env = { ...this.settings.env };
    if (authMethod === "api_key") {
      const apiKey = env.XAI_API_KEY ?? process.env.XAI_API_KEY;
      if (!apiKey) throw missingApiKeyError();
      env.XAI_API_KEY = apiKey;
    }

    const client = this.clientFactory({
      executable: this.settings.executablePath,
      cwd: this.settings.cwd,
      env,
      authMethod: authMethod === "api_key" ? false : authMethod,
      permissionMode:
        providerOptions?.permissionMode ??
        this.settings.permissionMode ??
        "default",
      requestTimeoutMs: this.settings.timeouts?.requestMs,
      onExtension: (event) => {
        if (!includeRawChunks && !includeExtensionEvents) return;
        if (extensionConsumer) extensionConsumer(event);
        else extensionEvents.push(event);
      },
    });

    try {
      const initialized = await client.initialize(signal);
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
        models = sessionResultModels(result);
        warnings.push({
          type: "compatibility",
          feature: "session load",
          details:
            "Grok advertises session/load, but replay ordering and cross-CWD behavior are not fixture-verified.",
        });
      } else {
        const result = await client.newSession({ cwd, mcpServers }, signal);
        sessionId = result.sessionId;
        models = result.models;
      }
      models ??= initialized._meta?.modelState;

      const requestedModel = providerOptions?.model ?? this.modelId;
      const resolvedModelId = models?.currentModelId ?? requestedModel;
      const requestedModelAvailable = models?.availableModels.some(
        (model) => model.modelId === requestedModel,
      );
      if (requestedModel !== "default" && models && !requestedModelAvailable) {
        warnings.push({
          type: "unsupported",
          feature: "model selection",
          details: `Requested model '${requestedModel}' is not present in Grok's advertised model catalog; ACP resolved '${resolvedModelId}'.`,
        });
      } else if (
        requestedModel !== "default" &&
        requestedModel !== resolvedModelId
      ) {
        warnings.push({
          type: "compatibility",
          feature: "model selection",
          details: `Requested model '${requestedModel}', but ACP resolved '${resolvedModelId}'. Grok 0.2.99 exposes no verified model setter, so the runtime model was retained.`,
        });
      }

      const effort = requestedReasoningEffort(options, providerOptions);
      if (effort) {
        const available = models?.availableModels
          .find((model) => model.modelId === models?.currentModelId)
          ?._meta?.reasoningEfforts?.map((item) => item.value);
        const current = currentReasoningEffort(models);
        if (!available?.includes(effort)) {
          warnings.push({
            type: "unsupported",
            feature: "reasoning",
            details: `Grok's resolved model does not advertise reasoning effort '${effort}'; it was ignored.`,
          });
        } else if (current !== effort) {
          warnings.push({
            type: "compatibility",
            feature: "reasoning",
            details: `Requested reasoning effort '${effort}', but ACP currently reports '${current ?? "unknown"}'. No verified setter is available, so the runtime effort was retained.`,
          });
        }
      }

      this.logger.debug(
        `Grok ACP session ${sessionId} prepared with model ${resolvedModelId}.`,
      );
      const currentEffort = currentReasoningEffort(models);
      const supportedEfforts = models?.availableModels
        .find((model) => model.modelId === resolvedModelId)
        ?._meta?.reasoningEfforts?.map((item) => item.value);
      return {
        client,
        sessionId,
        prompt: mappedPrompt.prompt,
        warnings,
        includeRawChunks,
        extensionEvents,
        attachExtensionConsumer: (consumer) => {
          extensionConsumer = consumer;
        },
        promptTimeoutMs: this.settings.timeouts?.promptMs,
        resolvedModelId,
        sessionMetadata: {
          sessionId,
          resolvedModelId,
          availableModels: models?.availableModels,
          currentReasoningEffort: currentEffort,
          supportedReasoningEfforts: supportedEfforts,
          agentVersion: initialized._meta?.agentVersion,
        },
      };
    } catch (error) {
      await client.dispose();
      throw error;
    }
  }
}
