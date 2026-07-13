/** ACP protocol v1 wire types used by Grok Build 0.2.99. */

export type JsonRpcId = string | number;
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonRpcRequest<
  Method extends string = string,
  Params = unknown,
> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: Method;
  params?: Params;
}

export interface JsonRpcNotification<
  Method extends string = string,
  Params = unknown,
> {
  jsonrpc: "2.0";
  method: Method;
  params?: Params;
}

export interface JsonRpcSuccess<Result = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: Result;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<Result = unknown> =
  | JsonRpcSuccess<Result>
  | JsonRpcFailure;
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export interface AcpMeta {
  [key: string]: unknown;
}

export interface AcpTextContent {
  type: "text";
  text: string;
  annotations?: AcpAnnotations | null;
  _meta?: AcpMeta | null;
}

export interface AcpImageContent {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: AcpAnnotations | null;
  _meta?: AcpMeta | null;
}

export interface AcpAudioContent {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: AcpAnnotations | null;
  _meta?: AcpMeta | null;
}

export interface AcpTextResourceContents {
  uri: string;
  text: string;
  mimeType?: string | null;
  _meta?: AcpMeta | null;
}

export interface AcpBlobResourceContents {
  uri: string;
  blob: string;
  mimeType?: string | null;
  _meta?: AcpMeta | null;
}

export interface AcpEmbeddedResource {
  type: "resource";
  resource: AcpTextResourceContents | AcpBlobResourceContents;
  annotations?: AcpAnnotations | null;
  _meta?: AcpMeta | null;
}

export interface AcpResourceLink {
  type: "resource_link";
  uri: string;
  name: string;
  description?: string | null;
  mimeType?: string | null;
  size?: number | null;
  annotations?: AcpAnnotations | null;
  _meta?: AcpMeta | null;
}

export interface AcpAnnotations {
  audience?: Array<"assistant" | "user"> | null;
  priority?: number | null;
  lastModified?: string | null;
  _meta?: AcpMeta | null;
}

export type AcpContentBlock =
  | AcpTextContent
  | AcpImageContent
  | AcpAudioContent
  | AcpEmbeddedResource
  | AcpResourceLink;

export interface AcpFileSystemCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
}

export interface AcpClientCapabilities {
  fs: AcpFileSystemCapabilities;
  terminal: boolean;
  _meta?: AcpMeta | null;
}

export interface AcpInitializeParams {
  protocolVersion: 1;
  clientCapabilities: AcpClientCapabilities;
  clientInfo?: AcpImplementation | null;
  _meta?: AcpMeta | null;
}

export interface AcpImplementation {
  name: string;
  version: string;
  title?: string | null;
  _meta?: AcpMeta | null;
}

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string | null;
  type?: "agent";
  _meta?: AcpMeta | null;
}

export interface AcpPromptCapabilities {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

export interface AcpMcpCapabilities {
  http: boolean;
  sse: boolean;
}

export interface AcpAgentCapabilities {
  loadSession: boolean;
  promptCapabilities: AcpPromptCapabilities;
  mcpCapabilities: AcpMcpCapabilities;
  sessionCapabilities: AcpMeta;
  auth?: AcpMeta;
  _meta?: AcpMeta | null;
}

export interface AcpReasoningEffort {
  id: string;
  value: string;
  label: string;
  description?: string;
  default?: boolean;
}

export interface AcpModelInfo {
  modelId: string;
  name: string;
  description?: string;
  _meta?: AcpMeta & {
    totalContextTokens?: number;
    agentType?: string;
    supportsReasoningEffort?: boolean;
    reasoningEffort?: string;
    reasoningEfforts?: AcpReasoningEffort[];
  };
}

export interface AcpModelState {
  currentModelId: string;
  availableModels: AcpModelInfo[];
}

export interface AcpAvailableCommand {
  name: string;
  description: string;
  input: { hint: string; [key: string]: JsonValue } | null;
  _meta?: AcpMeta | null;
}

export interface AcpInitializeResultMeta extends AcpMeta {
  grokShell?: boolean;
  defaultAuthMethodId?: string;
  currentWorkingDirectory?: string;
  agentVersion?: string;
  agentId?: string;
  agentInstanceId?: string;
  hostname?: string;
  modelState?: AcpModelState;
  mcpServers?: JsonValue[];
  mcpApps?: boolean;
  metadata?: JsonValue;
  availableCommands?: AcpAvailableCommand[];
  cancelRewind?: boolean;
  sessionRecap?: boolean;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: AcpAgentCapabilities;
  authMethods: AcpAuthMethod[];
  agentInfo?: AcpImplementation | null;
  _meta?: AcpInitializeResultMeta | null;
}

export interface AcpAuthenticateParams {
  methodId: string;
  _meta?: AcpMeta | null;
}

export interface AcpAuthenticateResult {
  _meta?: AcpMeta | null;
}

export interface AcpEnvVariable {
  name: string;
  value: string;
}

export interface AcpHttpHeader {
  name: string;
  value: string;
}

export interface AcpStdioMcpServer {
  type?: "stdio";
  name: string;
  command: string;
  args: string[];
  env: AcpEnvVariable[];
}

export interface AcpHttpMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: AcpHttpHeader[];
}

export interface AcpSseMcpServer {
  type: "sse";
  name: string;
  url: string;
  headers: AcpHttpHeader[];
}

export type AcpMcpServer =
  | AcpStdioMcpServer
  | AcpHttpMcpServer
  | AcpSseMcpServer;

export interface AcpNewSessionParams {
  cwd: string;
  mcpServers: AcpMcpServer[];
  additionalDirectories?: string[];
  _meta?: AcpMeta | null;
}

export interface AcpLoadSessionParams extends AcpNewSessionParams {
  sessionId: string;
}

export interface AcpSessionResultMeta extends AcpMeta {
  currentWorkingDirectory?: string;
  codebaseIndexed?: JsonValue[];
  isGitRepo?: boolean;
  gitRoot?: string | null;
  showNonGitWarning?: boolean;
  feedbackEnabled?: boolean;
}

export interface AcpSessionResult {
  sessionId: string;
  models?: AcpModelState;
  modes?: AcpMeta;
  configOptions?: JsonValue[];
  _meta?: AcpSessionResultMeta | null;
}

/** Stable ACP session/load returns an empty result after replay; Grok may add session state. */
export type AcpLoadSessionResult =
  | null
  | Record<string, never>
  | AcpSessionResult;

export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
  messageId?: string;
  _meta?: AcpMeta | null;
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | (string & {});

export interface AcpModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens?: number;
  reasoningTokens?: number;
  modelCalls?: number;
  apiDurationMs?: number;
  [key: string]: unknown;
}

export interface AcpPromptUsage extends AcpModelUsage {
  modelUsage?: Record<string, AcpModelUsage>;
  numTurns?: number;
}

export interface AcpPromptResultMeta extends AcpMeta {
  sessionId?: string;
  requestId?: string;
  promptId?: string;
  totalTokens?: number;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  reasoningTokens?: number;
  usage?: AcpPromptUsage;
}

export interface AcpPromptResult {
  stopReason: AcpStopReason;
  usage?: AcpPromptUsage | null;
  userMessageId?: string | null;
  _meta?: AcpPromptResultMeta | null;
}

export interface AcpCancelParams {
  sessionId: string;
  _meta?: AcpMeta | null;
}

export interface AcpEventMeta extends AcpMeta {
  totalTokens?: number;
  eventId?: string;
  agentTimestampMs?: number;
  promptId?: string;
  streamStartMs?: number;
  turnStartMs?: number;
  updateType?: string;
  updateParams?: AcpMeta;
  chunkId?: number;
}

export interface AcpMessageChunkUpdateBase {
  content: AcpContentBlock;
  messageId?: string;
  _meta?: AcpMeta | null;
}

export interface AcpAgentMessageChunkUpdate extends AcpMessageChunkUpdateBase {
  sessionUpdate: "agent_message_chunk";
}

export interface AcpAgentThoughtChunkUpdate extends AcpMessageChunkUpdateBase {
  sessionUpdate: "agent_thought_chunk";
}

export interface AcpUserMessageChunkUpdate extends AcpMessageChunkUpdateBase {
  sessionUpdate: "user_message_chunk";
}

export type AcpMessageChunkUpdate =
  | AcpAgentMessageChunkUpdate
  | AcpAgentThoughtChunkUpdate
  | AcpUserMessageChunkUpdate;

export interface AcpToolMetadata extends AcpMeta {
  version: number;
  name: string;
  kind: string;
  namespace: string;
  label: string;
  read_only: boolean;
  input?: JsonObject;
}

export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other"
  | (string & {});

export type AcpToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | (string & {});

export interface AcpToolCallContentBlock {
  type: "content";
  content: AcpContentBlock;
}

export interface AcpToolCallDiff {
  type: "diff";
  path: string;
  oldText?: string | null;
  newText: string;
}

export interface AcpToolCallTerminal {
  type: "terminal";
  terminalId: string;
}

export type AcpToolCallContent =
  | AcpToolCallContentBlock
  | AcpToolCallDiff
  | AcpToolCallTerminal;

export interface AcpToolCallLocation {
  path: string;
  line?: number | null;
}

export interface AcpToolCallUpdateBase {
  toolCallId: string;
  title?: string;
  kind?: AcpToolKind;
  status?: AcpToolCallStatus;
  content?: AcpToolCallContent[];
  locations?: AcpToolCallLocation[];
  rawInput?: JsonObject;
  rawOutput?: JsonObject;
  _meta?: (AcpMeta & { "x.ai/tool"?: AcpToolMetadata }) | null;
}

export interface AcpToolCallUpdate extends AcpToolCallUpdateBase {
  sessionUpdate: "tool_call";
  title: string;
  rawInput: JsonObject;
  _meta: AcpMeta & { "x.ai/tool": AcpToolMetadata };
}

export interface AcpToolCallProgressUpdate extends AcpToolCallUpdateBase {
  sessionUpdate: "tool_call_update";
}

export interface AcpPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
  _meta?: AcpMeta | null;
}

export interface AcpPlanUpdate {
  sessionUpdate: "plan";
  entries: AcpPlanEntry[];
  _meta?: AcpMeta | null;
}

export interface AcpAvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: AcpAvailableCommand[];
  _meta?: AcpMeta | null;
}

/** Fallback deliberately remains open so optional protocol drift is observable. */
export interface AcpUnknownSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export type AcpSessionUpdate =
  | AcpMessageChunkUpdate
  | AcpToolCallUpdate
  | AcpToolCallProgressUpdate
  | AcpPlanUpdate
  | AcpAvailableCommandsUpdate
  | AcpUnknownSessionUpdate;

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: AcpSessionUpdate;
  _meta?: AcpEventMeta | null;
}

export type AcpSessionUpdateNotification = JsonRpcNotification<
  "session/update",
  AcpSessionUpdateParams
>;

export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
  _meta?: AcpMeta | null;
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCallProgressUpdate;
  options: AcpPermissionOption[];
  _meta?: AcpMeta | null;
}

export type AcpRequestPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface AcpRequestPermissionResult {
  outcome: AcpRequestPermissionOutcome;
  _meta?: AcpMeta | null;
}

export interface AcpReadTextFileParams {
  sessionId: string;
  path: string;
  line?: number | null;
  limit?: number | null;
  _meta?: AcpMeta | null;
}

export interface AcpReadTextFileResult {
  content: string;
  _meta?: AcpMeta | null;
}

export interface AcpWriteTextFileParams {
  sessionId: string;
  path: string;
  content: string;
  _meta?: AcpMeta | null;
}

export type AcpWriteTextFileResult = null | Record<string, never>;

export type ObservedXaiExtensionMethod =
  | "_x.ai/announcements/update"
  | "_x.ai/mcp/init_progress"
  | "_x.ai/mcp/server_status"
  | "_x.ai/mcp/servers_updated"
  | "_x.ai/mcp_initialized"
  | "_x.ai/models/update"
  | "_x.ai/queue/changed"
  | "_x.ai/session/prompt_complete"
  | "_x.ai/session_notification"
  | "_x.ai/sessions/changed"
  | "_x.ai/settings/update";

export interface AcpExtensionNotification {
  jsonrpc: "2.0";
  method: ObservedXaiExtensionMethod | (string & {});
  params?: unknown;
}

export interface AcpRequestMap {
  initialize: { params: AcpInitializeParams; result: AcpInitializeResult };
  authenticate: {
    params: AcpAuthenticateParams;
    result: AcpAuthenticateResult;
  };
  "session/new": { params: AcpNewSessionParams; result: AcpSessionResult };
  "session/load": {
    params: AcpLoadSessionParams;
    result: AcpLoadSessionResult;
  };
  "session/prompt": { params: AcpPromptParams; result: AcpPromptResult };
}

export interface AcpNotificationMap {
  "session/cancel": AcpCancelParams;
}

export interface AcpAgentRequestMap {
  "session/request_permission": {
    params: AcpRequestPermissionParams;
    result: AcpRequestPermissionResult;
  };
  "fs/read_text_file": {
    params: AcpReadTextFileParams;
    result: AcpReadTextFileResult;
  };
  "fs/write_text_file": {
    params: AcpWriteTextFileParams;
    result: AcpWriteTextFileResult;
  };
}

export type AcpKnownRequest = {
  [Method in keyof AcpRequestMap]: JsonRpcRequest<
    Method,
    AcpRequestMap[Method]["params"]
  >;
}[keyof AcpRequestMap];

export type AcpKnownNotification = {
  [Method in keyof AcpNotificationMap]: JsonRpcNotification<
    Method,
    AcpNotificationMap[Method]
  >;
}[keyof AcpNotificationMap];

export type AcpKnownAgentRequest = {
  [Method in keyof AcpAgentRequestMap]: JsonRpcRequest<
    Method,
    AcpAgentRequestMap[Method]["params"]
  >;
}[keyof AcpAgentRequestMap];
