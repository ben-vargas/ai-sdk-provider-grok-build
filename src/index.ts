export {
  createGrokBuild,
  grokBuild,
  type GrokBuildProvider,
} from "./grok-build-provider.js";
export {
  createGrokAgent,
  grokAgent,
  type CreateGrokAgentOptions,
  type GrokAgentProvider,
} from "./grok-agent-provider.js";
export {
  createGrokExec,
  grokExec,
  type CreateGrokExecOptions,
  type GrokExecProvider,
} from "./grok-exec-provider.js";
export {
  GrokBuildLanguageModel,
  type AcpClientFactory,
  type GrokBuildLanguageModelOptions,
} from "./grok-build-language-model.js";
export {
  GrokExecLanguageModel,
  type ExecChildProcess,
  type ExecSpawnFactory,
  type GrokExecLanguageModelOptions,
} from "./grok-exec-language-model.js";
export {
  grokBuildMcpServerSchema,
  grokBuildProviderOptionsSchema,
  grokBuildSettingsSchema,
  grokExecProviderOptionsSchema,
  grokExecSettingsSchema,
  type GrokBuildAuthMethod,
  type GrokBuildLogger,
  type GrokBuildProviderOptions,
  type GrokBuildSessionOptions,
  type GrokBuildSettings,
  type GrokBuildTimeouts,
  type GrokAgentProviderOptions,
  type GrokAgentSettings,
  type GrokExecProviderOptions,
  type GrokExecSettings,
  type GrokProcessSettings,
  type ReasoningEffort,
} from "./settings.js";
export type {
  AcpConfigOption,
  AcpConfigSelectChoice,
  AcpHttpMcpServer,
  AcpMcpServer,
  AcpSseMcpServer,
  AcpStdioMcpServer,
  AcpSetConfigOptionParams,
  AcpSetConfigOptionResult,
} from "./acp/protocol.js";
export {
  AcpClient,
  NdjsonFramer,
  type AcpChildProcess,
  type AcpClientOptions,
  type AcpFileSystemSettings,
  type AcpPromptOptions,
  type AcpPromptOutcome,
  type AcpSpawnFactory,
  type AcpSpawnOptions,
  type PermissionMode,
  type PermissionHandler,
  type ReadTextFileHandler,
  type WriteTextFileHandler,
} from "./acp/client.js";
export {
  createGrokBuildAuthenticationError,
  GrokCliError,
  isMissingExecutableError,
  mapAcpError,
  mapGrokExecError,
} from "./errors.js";
export {
  ensureGrokCliVersion,
  resolveGrokCommand,
  type GrokCommandSource,
  type GrokVersionCheckOptions,
  type ResolvedGrokCommand,
  type ResolveGrokCommandOptions,
} from "./grok-cli.js";

export const VERSION = "1.1.0";
