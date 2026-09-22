import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4ResponseMetadata,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import { parseProviderOptions } from "@ai-sdk/provider-utils";
import { abortError } from "./abort.js";
import { NdjsonFramer } from "./acp/client.js";
import { AcpProtocolError, stderrTail } from "./acp/errors.js";
import type { JsonValue } from "./acp/protocol.js";
import { GrokCliError, mapGrokExecError } from "./errors.js";
import { ensureGrokCliVersion, resolveGrokCommand } from "./grok-cli.js";
import {
  HeadlessEventNormalizer,
  isHeadlessTerminalEvent,
  type HeadlessTerminalEvent,
} from "./headless-events.js";
import { mapGrokBuildFinishReason } from "./map-finish-reason.js";
import { mergeDefined } from "./merge-defined.js";
import { resolveGrokLogger } from "./logger.js";
import { mapGrokExecCallWarnings, mapGrokExecPrompt } from "./map-prompt.js";
import { GrokBuildV4StreamEmitter } from "./map-v4-events.js";
import { mapGrokBuildUsage, grokBuildProviderMetadata } from "./map-usage.js";
import type { NormalizedCompletionMetadata } from "./normalized-usage.js";
import { redactSensitiveData } from "./redact.js";
import { isRecord } from "./type-guards.js";
import {
  grokExecProviderOptionsSchema,
  validateGrokBuildModelId,
  validateGrokExecSettings,
  type GrokBuildLogger,
  type GrokExecProviderOptions,
  type GrokExecSettings,
  type ReasoningEffort,
} from "./settings.js";

const DEFAULT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const DEFAULT_TERMINATE_GRACE = 500;
const DEFAULT_KILL_GRACE = 250;
const STDERR_LIMIT = 32 * 1024;

export interface ExecChildProcess {
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type ExecSpawnFactory = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => ExecChildProcess;

export interface GrokExecLanguageModelOptions {
  id: string;
  settings?: GrokExecSettings;
  spawn?: ExecSpawnFactory;
  skipCliValidation?: boolean;
}

function numberField(
  source: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeUsage(source?: Record<string, unknown>) {
  const input = numberField(
    source,
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
  );
  const grokCacheRead = numberField(
    source,
    "cache_read_input_tokens",
    "cacheReadInputTokens",
  );
  const grokCacheWrite = numberField(
    source,
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_write_input_tokens",
    "cacheWriteInputTokens",
  );
  const openAiCacheRead = numberField(source, "cached_tokens");
  const openAiStyle =
    openAiCacheRead !== undefined ||
    numberField(source, "prompt_tokens") !== undefined;
  const cacheRead = openAiStyle ? openAiCacheRead : grokCacheRead;
  const cacheWrite = openAiStyle ? undefined : grokCacheWrite;
  const inputNoCache = openAiStyle
    ? input !== undefined && cacheRead !== undefined
      ? input >= cacheRead
        ? input - cacheRead
        : undefined
      : input
    : input;
  const inputComponents = [input, grokCacheRead, grokCacheWrite];
  return {
    inputTotal: openAiStyle
      ? input
      : inputComponents.some((value) => value !== undefined)
        ? inputComponents.reduce<number>(
            (total, value) => total + (value ?? 0),
            0,
          )
        : undefined,
    inputNoCache,
    cacheRead,
    cacheWrite,
    outputTotal: numberField(
      source,
      "output_tokens",
      "outputTokens",
      "completion_tokens",
    ),
    reasoning: numberField(
      source,
      "reasoning_tokens",
      "reasoningTokens",
      "thinking_tokens",
    ),
    raw: source ? redactSensitiveData(source) : undefined,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mergeProviderOptions(
  settings: GrokExecSettings,
  options: GrokExecProviderOptions | undefined,
): GrokExecSettings {
  return mergeDefined(settings, options ?? {});
}

function requestedEffort(
  options: LanguageModelV4CallOptions,
  providerOptions: GrokExecProviderOptions | undefined,
  settings: GrokExecSettings,
): ReasoningEffort | undefined {
  if (providerOptions?.reasoningEffort) return providerOptions.reasoningEffort;
  if (options.reasoning && options.reasoning !== "provider-default") {
    return options.reasoning as ReasoningEffort;
  }
  return settings.reasoningEffort;
}

function providerMetadata(
  terminal: HeadlessTerminalEvent,
  modelId: string,
): SharedV4ProviderMetadata {
  const metadata: NormalizedCompletionMetadata = {
    sessionId: terminal.sessionId ?? "unknown",
    requestId: terminal.requestId,
    stopReason: terminal.stopReason,
    resolvedModel: modelId,
    modelUsage: redactSensitiveData(terminal.modelUsage),
  };
  return grokBuildProviderMetadata(metadata);
}

function collectGeneratedResult(
  streamResult: LanguageModelV4StreamResult,
): Promise<LanguageModelV4GenerateResult> {
  return (async () => {
    const content: LanguageModelV4Content[] = [];
    const indexes = new Map<string, number>();
    const toolResultIndexes = new Map<string, number>();
    let warnings: SharedV4Warning[] = [];
    let finishReason: LanguageModelV4GenerateResult["finishReason"] | undefined;
    let usage: LanguageModelV4Usage | undefined;
    let metadata: SharedV4ProviderMetadata | undefined;
    let response: LanguageModelV4ResponseMetadata | undefined;
    for await (const part of streamResult.stream) {
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
          indexes.set(part.id, content.length);
          content.push({ type: "text", text: "" });
          break;
        case "reasoning-start":
          indexes.set(part.id, content.length);
          content.push({ type: "reasoning", text: "" });
          break;
        case "text-delta":
        case "reasoning-delta": {
          const index = indexes.get(part.id);
          const existing = index === undefined ? undefined : content[index];
          if (
            existing &&
            ((part.type === "text-delta" && existing.type === "text") ||
              (part.type === "reasoning-delta" &&
                existing.type === "reasoning"))
          ) {
            existing.text += part.delta;
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
        message: "Grok CLI stream ended without a terminal finish record.",
        url: "grok-build://exec",
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
      request: streamResult.request,
    };
  })();
}

export class GrokExecLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "grok-build";
  readonly supportedUrls = {};
  readonly modelId: string;

  private readonly settings: GrokExecSettings;
  private readonly logger: GrokBuildLogger;
  private readonly spawnProcess: ExecSpawnFactory;
  private readonly skipCliValidation: boolean;

  constructor(options: GrokExecLanguageModelOptions) {
    this.modelId = validateGrokBuildModelId(options.id);
    this.settings = validateGrokExecSettings(options.settings ?? {});
    this.logger = resolveGrokLogger(
      this.settings.logger,
      this.settings.verbose,
    );
    this.spawnProcess =
      options.spawn ??
      ((command, args, spawnOptions) =>
        spawn(command, [...args], spawnOptions) as ExecChildProcess);
    this.skipCliValidation =
      options.skipCliValidation ?? options.spawn !== undefined;
  }

  async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    return await collectGeneratedResult(await this.doStream(options));
  }

  async doStream(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    const providerOptions = await parseProviderOptions<GrokExecProviderOptions>(
      {
        provider: this.provider,
        providerOptions: options.providerOptions,
        schema: grokExecProviderOptionsSchema,
      },
    );
    const settings = mergeProviderOptions(this.settings, providerOptions);
    settings.reasoningEffort = requestedEffort(
      options,
      providerOptions,
      this.settings,
    );
    const mapped = await mapGrokExecPrompt(
      options.prompt,
      options.responseFormat,
    );
    const warnings = [...mapGrokExecCallWarnings(options), ...mapped.warnings];
    const responseSchema =
      options.responseFormat?.type === "json"
        ? options.responseFormat.schema
        : undefined;
    const structured = responseSchema !== undefined;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...settings.env,
      ...(settings.apiKey ? { XAI_API_KEY: settings.apiKey } : {}),
      ...(settings.xaiApiBaseUrl
        ? { XAI_API_BASE_URL: settings.xaiApiBaseUrl }
        : {}),
    };
    const command = await resolveGrokCommand({
      executablePath: settings.executablePath,
      allowPackageBin: settings.allowPackageBin,
      allowNpx: settings.allowNpx,
      cwd: settings.cwd,
      env,
    });
    if (!this.skipCliValidation) {
      await ensureGrokCliVersion(command, {
        cwd: settings.cwd,
        env,
        signal: options.abortSignal,
      });
    }

    const temporaryDirectory = await fs.mkdtemp(join(tmpdir(), "grok-exec-"));
    const promptPath = join(temporaryDirectory, "prompt.txt");
    try {
      await fs.writeFile(promptPath, mapped.prompt, { mode: 0o600 });
    } catch (error) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
    let args: string[];
    try {
      args = this.buildArgs(
        command.prefixArgs,
        promptPath,
        settings,
        structured ? responseSchema : undefined,
      );
    } catch (error) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
    const outputLimit = settings.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;
    const cleanup = async (): Promise<void> => {
      try {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn(
          `Could not remove Grok temporary prompt directory: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    if (options.abortSignal?.aborted) {
      await cleanup();
      throw abortError(options.abortSignal, "The Grok CLI call was aborted.");
    }

    let terminate: ((reason?: unknown) => Promise<void>) | undefined;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      start: (controller) => {
        const emitter = new GrokBuildV4StreamEmitter(
          controller,
          Boolean(settings.includeRawChunks || options.includeRawChunks),
          (warning) =>
            this.logger.warn(
              warning.type === "compatibility"
                ? (warning.details ?? warning.feature)
                : "Grok compatibility warning",
            ),
        );
        emitter.emitStart(warnings, this.modelId);
        let child: ExecChildProcess;
        try {
          child = this.spawnProcess(command.command, args, {
            cwd: settings.cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (cause) {
          void cleanup();
          emitter.error(
            mapGrokExecError(
              new GrokCliError(
                `Failed to start Grok CLI: ${cause instanceof Error ? cause.message : String(cause)}`,
                { code: "GROK_CLI_SPAWN_FAILED", cause },
              ),
              { modelId: this.modelId },
            ),
          );
          return;
        }
        let closed = false;
        let aborted = false;
        let processExited = false;
        let stderr = "";
        let structuredBuffer = "";
        let structuredBytes = 0;
        const structuredDecoder = new StringDecoder("utf8");
        let terminal: HeadlessTerminalEvent | undefined;
        let promptTimer: ReturnType<typeof setTimeout> | undefined;
        const normalizer = new HeadlessEventNormalizer();
        let resolveExit!: () => void;
        const exited = new Promise<void>((resolve) => {
          resolveExit = resolve;
        });

        const fail = (error: unknown): void => {
          if (closed) return;
          closed = true;
          if (promptTimer) clearTimeout(promptTimer);
          emitter.error(mapGrokExecError(error, { modelId: this.modelId }));
        };
        const terminateChild = async (reason?: unknown): Promise<void> => {
          aborted = true;
          if (processExited) return;
          child.kill("SIGTERM");
          await Promise.race([
            exited,
            delay(
              settings.timeouts?.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE,
            ),
          ]);
          if (!processExited) child.kill("SIGKILL");
          await Promise.race([
            exited,
            delay(settings.timeouts?.killGraceMs ?? DEFAULT_KILL_GRACE),
          ]);
          if (reason !== undefined && !closed) fail(reason);
          await cleanup();
        };
        terminate = terminateChild;
        if (settings.timeouts?.promptMs !== undefined) {
          promptTimer = setTimeout(() => {
            void terminateChild(
              new GrokCliError(
                `Grok headless prompt timed out after ${String(settings.timeouts?.promptMs)}ms.`,
                { code: "GROK_CLI_PROMPT_TIMEOUT" },
              ),
            );
          }, settings.timeouts.promptMs);
        }

        const processStreamingLine = (line: string): void => {
          if (closed) return;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch (cause) {
            throw new AcpProtocolError(
              `Invalid JSON from Grok headless stdout: ${line.slice(0, 200)}`,
              { cause },
            );
          }
          emitter.emitNormalized(normalizer.normalize(value));
          if (isHeadlessTerminalEvent(value)) terminal = value;
        };
        const framer = new NdjsonFramer((line) => {
          try {
            processStreamingLine(line);
          } catch (error) {
            fail(error);
            void terminateChild();
          }
        });

        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr = `${stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
        });
        child.stdout.on("data", (chunk: Buffer | string) => {
          if (closed) return;
          if (structured) {
            const bytes =
              typeof chunk === "string"
                ? Buffer.byteLength(chunk)
                : chunk.byteLength;
            structuredBytes += bytes;
            structuredBuffer +=
              typeof chunk === "string"
                ? chunk
                : structuredDecoder.write(Buffer.from(chunk));
            if (structuredBytes > outputLimit) {
              fail(
                new GrokCliError(
                  `Grok structured output exceeded the ${outputLimit}-byte limit.`,
                  { code: "OUTPUT_LIMIT_EXCEEDED" },
                ),
              );
              void terminateChild();
            }
          } else {
            framer.push(chunk);
          }
        });
        child.once("error", (cause) => {
          if (promptTimer) clearTimeout(promptTimer);
          resolveExit();
          fail(
            new GrokCliError(`Failed to start Grok CLI: ${cause.message}`, {
              code:
                (cause as NodeJS.ErrnoException).code ??
                "GROK_CLI_SPAWN_FAILED",
              cause,
            }),
          );
          void cleanup();
        });
        child.once("close", (code, signal) => {
          if (promptTimer) clearTimeout(promptTimer);
          processExited = true;
          resolveExit();
          options.abortSignal?.removeEventListener("abort", onAbort);
          void (async () => {
            try {
              if (aborted || closed) return;
              if (code !== 0) {
                throw new GrokCliError(
                  `Grok CLI exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}.`,
                  {
                    code: "GROK_CLI_PROCESS_EXIT",
                    exitCode: code,
                    stderr: String(
                      redactSensitiveData(stderrTail(stderr)) ?? "",
                    ),
                  },
                );
              }
              if (structured) {
                structuredBuffer += structuredDecoder.end();
                terminal = this.emitStructuredResult(
                  structuredBuffer,
                  emitter,
                  outputLimit,
                );
              } else {
                framer.end();
                if (!terminal) {
                  throw new AcpProtocolError(
                    "Grok headless stream ended without a valid terminal 'end' event.",
                  );
                }
                emitter.emitNormalized(normalizer.finish());
              }
              const completed = terminal;
              if (!completed) {
                throw new AcpProtocolError(
                  "Grok headless generation produced no terminal metadata.",
                );
              }
              emitter.emitFinish(
                mapGrokBuildFinishReason(completed.stopReason),
                mapGrokBuildUsage(normalizeUsage(completed.usage)),
                providerMetadata(completed, this.modelId),
              );
              closed = true;
              emitter.close();
            } catch (error) {
              fail(error);
            } finally {
              await cleanup();
            }
          })();
        });

        const onAbort = (): void => {
          if (promptTimer) clearTimeout(promptTimer);
          const reason = options.abortSignal
            ? abortError(options.abortSignal, "The Grok CLI call was aborted.")
            : new Error("The Grok CLI call was aborted.");
          if (!closed) {
            closed = true;
            emitter.error(reason);
          }
          void terminateChild();
        };
        options.abortSignal?.addEventListener("abort", onAbort, { once: true });
      },
      cancel: async (reason) => {
        await terminate?.(reason);
        await cleanup();
      },
    });

    return { stream, request: { body: mapped.prompt } };
  }

  private buildArgs(
    prefixArgs: string[],
    promptPath: string,
    settings: GrokExecSettings,
    schema: unknown,
  ): string[] {
    const args = [...prefixArgs, "--no-auto-update"];
    if (schema !== undefined) {
      args.push("--json-schema", JSON.stringify(schema));
    } else {
      args.push("--output-format", "streaming-json");
    }
    if (this.modelId !== "default") args.push("--model", this.modelId);
    if (settings.reasoningEffort)
      args.push("--reasoning-effort", settings.reasoningEffort);
    if (settings.dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    } else {
      if (settings.alwaysApprove) args.push("--always-approve");
      args.push("--permission-mode", settings.permissionMode ?? "dontAsk");
    }
    if (settings.sandbox) args.push("--sandbox", settings.sandbox);
    for (const rule of settings.allowRules ?? []) args.push("--allow", rule);
    for (const rule of settings.denyRules ?? []) args.push("--deny", rule);
    if (settings.allowedTools?.length)
      args.push("--tools", settings.allowedTools.join(","));
    if (settings.disallowedTools?.length)
      args.push("--disallowed-tools", settings.disallowedTools.join(","));
    if (settings.maxTurns !== undefined)
      args.push("--max-turns", String(settings.maxTurns));
    if (settings.webSearch === false) args.push("--disable-web-search");
    if (settings.systemPromptOverride !== undefined)
      args.push("--system-prompt-override", settings.systemPromptOverride);
    if (settings.appendRules !== undefined)
      args.push("--rules", settings.appendRules);
    if (settings.noPlan) args.push("--no-plan");
    if (settings.noSubagents) args.push("--no-subagents");
    if (settings.session?.resume)
      args.push("--resume", settings.session.resume);
    if (settings.session?.continue) args.push("--continue");
    if (settings.session?.fork) args.push("--fork-session");
    if (settings.session?.id) args.push("--session-id", settings.session.id);
    args.push("--prompt-file", promptPath);
    return args;
  }

  private emitStructuredResult(
    raw: string,
    emitter: GrokBuildV4StreamEmitter,
    outputLimit: number,
  ): HeadlessTerminalEvent {
    if (Buffer.byteLength(raw) > outputLimit) {
      throw new GrokCliError(
        `Grok structured output exceeded the ${outputLimit}-byte limit.`,
        { code: "OUTPUT_LIMIT_EXCEEDED" },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new AcpProtocolError("Grok returned malformed structured JSON.", {
        cause,
      });
    }
    if (!isRecord(parsed)) {
      throw new AcpProtocolError(
        "Grok structured output must be a JSON object wrapper.",
      );
    }
    const wrapper = parsed;
    const stopReason =
      typeof wrapper.stopReason === "string"
        ? wrapper.stopReason
        : typeof wrapper.stop_reason === "string"
          ? wrapper.stop_reason
          : undefined;
    if (!stopReason) {
      throw new AcpProtocolError(
        "Grok structured output omitted its terminal stop reason.",
      );
    }
    const hasStructuredOutput =
      Object.hasOwn(wrapper, "structuredOutput") ||
      Object.hasOwn(wrapper, "structured_output");
    const value = hasStructuredOutput
      ? Object.hasOwn(wrapper, "structuredOutput")
        ? wrapper.structuredOutput
        : wrapper.structured_output
      : Object.hasOwn(wrapper, "result")
        ? wrapper.result === null && typeof wrapper.text === "string"
          ? wrapper.text
          : wrapper.result
        : wrapper.text;
    if (value === undefined) {
      throw new AcpProtocolError(
        "Grok structured output omitted the generated JSON payload.",
      );
    }
    const text = hasStructuredOutput
      ? JSON.stringify(value)
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
    const id = randomUUID();
    emitter.emitNormalized([
      { kind: "text-start", id },
      { kind: "text-delta", id, delta: text },
      { kind: "text-end", id },
      {
        kind: "raw",
        value: redactSensitiveData(wrapper) ?? ({} as JsonValue),
        conditional: true,
      },
    ]);
    return {
      type: "end",
      stopReason,
      sessionId:
        typeof wrapper.sessionId === "string"
          ? wrapper.sessionId
          : typeof wrapper.session_id === "string"
            ? wrapper.session_id
            : undefined,
      requestId:
        typeof wrapper.requestId === "string"
          ? wrapper.requestId
          : typeof wrapper.request_id === "string"
            ? wrapper.request_id
            : undefined,
      usage: isRecord(wrapper.usage) ? wrapper.usage : undefined,
      modelUsage: wrapper.modelUsage ?? wrapper.model_usage,
    };
  }
}
