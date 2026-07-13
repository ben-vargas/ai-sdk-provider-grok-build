export {
  createGrokBuild,
  grokBuild,
  type GrokBuildProvider,
} from "./grok-build-provider.js";
export {
  GrokBuildLanguageModel,
  type AcpClientFactory,
  type GrokBuildLanguageModelOptions,
} from "./grok-build-language-model.js";
export {
  grokBuildMcpServerSchema,
  grokBuildProviderOptionsSchema,
  grokBuildSettingsSchema,
  type GrokBuildAuthMethod,
  type GrokBuildLogger,
  type GrokBuildProviderOptions,
  type GrokBuildSessionOptions,
  type GrokBuildSettings,
  type GrokBuildTimeouts,
} from "./settings.js";
export type {
  AcpHttpMcpServer,
  AcpMcpServer,
  AcpSseMcpServer,
  AcpStdioMcpServer,
} from "./acp/protocol.js";
export type { PermissionMode } from "./acp/client.js";
export {
  createGrokBuildAuthenticationError,
  isMissingExecutableError,
  mapAcpError,
} from "./errors.js";

export const VERSION = "0.1.0";
