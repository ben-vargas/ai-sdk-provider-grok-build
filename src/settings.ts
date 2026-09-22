import { z } from "zod";
import type {
  AcpFileSystemSettings,
  PermissionHandler,
  PermissionMode,
} from "./acp/client.js";
import type { AcpMcpServer } from "./acp/protocol.js";
import { mergeDefined } from "./merge-defined.js";

export interface GrokBuildLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type GrokBuildAuthMethod = "cached_token" | "api_key" | (string & {});
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface GrokBuildTimeouts {
  requestMs?: number;
  promptMs?: number;
  cancelGraceMs?: number;
  terminateGraceMs?: number;
  killGraceMs?: number;
}

export interface GrokProcessSettings {
  executablePath?: string;
  allowPackageBin?: boolean;
  allowNpx?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  xaiApiBaseUrl?: string;
  logger?: GrokBuildLogger | false;
  verbose?: boolean;
  timeouts?: GrokBuildTimeouts;
  maxOutputBytes?: number;
}

export interface GrokBuildSettings extends GrokProcessSettings {
  authMethod?: GrokBuildAuthMethod;
  permissionMode?: PermissionMode;
  defaultModel?: string;
  reasoningEffort?: ReasoningEffort;
  mcpServers?: AcpMcpServer[];
  includeRawChunks?: boolean;
  alwaysApprove?: boolean;
  dangerouslySkipPermissions?: boolean;
  onPermissionRequest?: PermissionHandler;
  fileSystem?: AcpFileSystemSettings;
}

export type GrokAgentSettings = GrokBuildSettings;

export interface GrokBuildSessionOptions {
  id?: string;
  resume?: string;
  continue?: boolean;
  fork?: boolean;
}

export interface GrokBuildProviderOptions {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  session?: GrokBuildSessionOptions;
  permissionMode?: PermissionMode;
  mcpServers?: AcpMcpServer[];
  maxTurns?: number;
  includeExtensionEvents?: boolean;
  alwaysApprove?: boolean;
  dangerouslySkipPermissions?: boolean;
}

export type GrokAgentProviderOptions = GrokBuildProviderOptions;

export interface GrokExecSettings extends GrokProcessSettings {
  defaultModel?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox?: string;
  permissionMode?: PermissionMode;
  alwaysApprove?: boolean;
  dangerouslySkipPermissions?: boolean;
  allowRules?: string[];
  denyRules?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  webSearch?: boolean;
  systemPromptOverride?: string;
  appendRules?: string;
  noPlan?: boolean;
  noSubagents?: boolean;
  session?: GrokBuildSessionOptions;
  includeRawChunks?: boolean;
}

export interface GrokExecProviderOptions {
  reasoningEffort?: ReasoningEffort;
  sandbox?: string;
  permissionMode?: PermissionMode;
  alwaysApprove?: boolean;
  dangerouslySkipPermissions?: boolean;
  allowRules?: string[];
  denyRules?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  webSearch?: boolean;
  systemPromptOverride?: string;
  appendRules?: string;
  noPlan?: boolean;
  noSubagents?: boolean;
  session?: GrokBuildSessionOptions;
}

const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const permissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
]);

const envVariableSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});
const headerSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});

export const grokBuildMcpServerSchema = z.union([
  z
    .object({
      type: z.literal("stdio").optional(),
      name: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()),
      env: z.array(envVariableSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      name: z.string().min(1),
      url: z.string().url(),
      headers: z.array(headerSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("sse"),
      name: z.string().min(1),
      url: z.string().url(),
      headers: z.array(headerSchema),
    })
    .strict(),
]);

const loggerSchema = z.custom<GrokBuildLogger>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    ["debug", "info", "warn", "error"].every(
      (method) =>
        typeof (value as Record<string, unknown>)[method] === "function",
    ),
  "logger must implement debug, info, warn, and error methods",
);

const timeoutsSchema = z
  .object({
    requestMs: z.number().int().positive().optional(),
    promptMs: z.number().int().positive().optional(),
    cancelGraceMs: z.number().int().nonnegative().optional(),
    terminateGraceMs: z.number().int().nonnegative().optional(),
    killGraceMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

const processSettingsShape = {
  executablePath: z.string().min(1).optional(),
  allowPackageBin: z.boolean().optional(),
  allowNpx: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string().optional()).optional(),
  apiKey: z.string().min(1).optional(),
  xaiApiBaseUrl: z.string().url().optional(),
  logger: z.union([loggerSchema, z.literal(false)]).optional(),
  verbose: z.boolean().optional(),
  timeouts: timeoutsSchema,
  maxOutputBytes: z.number().int().positive().optional(),
};

export const grokBuildSettingsSchema: z.ZodType<GrokBuildSettings> = z
  .object({
    ...processSettingsShape,
    authMethod: z.string().min(1).optional(),
    permissionMode: permissionModeSchema.optional(),
    defaultModel: z.string().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    mcpServers: z.array(grokBuildMcpServerSchema).optional(),
    includeRawChunks: z.boolean().optional(),
    alwaysApprove: z.boolean().optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    onPermissionRequest: z
      .custom<PermissionHandler>((value) => typeof value === "function")
      .optional(),
    fileSystem: z
      .object({
        readTextFile: z
          .union([
            z.boolean(),
            z.custom<NonNullable<AcpFileSystemSettings["readTextFile"]>>(
              (value) => typeof value === "function",
            ),
          ])
          .optional(),
        writeTextFile: z
          .union([
            z.boolean(),
            z.custom<NonNullable<AcpFileSystemSettings["writeTextFile"]>>(
              (value) => typeof value === "function",
            ),
          ])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const grokBuildModelIdSchema = z.string().trim().min(1);
export function validateGrokBuildModelId(modelId: string): string {
  return grokBuildModelIdSchema.parse(modelId);
}

const sessionOptionsSchema = z
  .object({
    id: z.string().min(1).optional(),
    resume: z.string().min(1).optional(),
    continue: z.boolean().optional(),
    fork: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.resume !== undefined && value.continue) {
      context.addIssue({
        code: "custom",
        message: "session.resume and session.continue are mutually exclusive",
      });
    }
    if (value.fork && value.resume === undefined && !value.continue) {
      context.addIssue({
        code: "custom",
        message: "session.fork requires session.resume or session.continue",
      });
    }
    if (
      value.id !== undefined &&
      (value.resume !== undefined || value.continue) &&
      !value.fork
    ) {
      context.addIssue({
        code: "custom",
        message:
          "session.id names a new session or fork and requires session.fork when combined with session.resume or session.continue",
      });
    }
  });

export const grokBuildProviderOptionsSchema: z.ZodType<GrokBuildProviderOptions> =
  z
    .object({
      model: z.string().min(1).optional(),
      reasoningEffort: reasoningEffortSchema.optional(),
      session: sessionOptionsSchema.optional(),
      permissionMode: permissionModeSchema.optional(),
      mcpServers: z.array(grokBuildMcpServerSchema).optional(),
      maxTurns: z.number().int().positive().optional(),
      includeExtensionEvents: z.boolean().optional(),
      alwaysApprove: z.boolean().optional(),
      dangerouslySkipPermissions: z.boolean().optional(),
    })
    .strict();

export const grokExecSettingsSchema: z.ZodType<GrokExecSettings> = z
  .object({
    ...processSettingsShape,
    defaultModel: z.string().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
    sandbox: z.string().min(1).optional(),
    permissionMode: permissionModeSchema.optional(),
    alwaysApprove: z.boolean().optional(),
    dangerouslySkipPermissions: z.boolean().optional(),
    allowRules: z.array(z.string().min(1)).optional(),
    denyRules: z.array(z.string().min(1)).optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    disallowedTools: z.array(z.string().min(1)).optional(),
    maxTurns: z.number().int().positive().optional(),
    webSearch: z.boolean().optional(),
    systemPromptOverride: z.string().optional(),
    appendRules: z.string().optional(),
    noPlan: z.boolean().optional(),
    noSubagents: z.boolean().optional(),
    session: sessionOptionsSchema.optional(),
    includeRawChunks: z.boolean().optional(),
  })
  .strict();

export const grokExecProviderOptionsSchema: z.ZodType<GrokExecProviderOptions> =
  z
    .object({
      reasoningEffort: reasoningEffortSchema.optional(),
      sandbox: z.string().min(1).optional(),
      permissionMode: permissionModeSchema.optional(),
      alwaysApprove: z.boolean().optional(),
      dangerouslySkipPermissions: z.boolean().optional(),
      allowRules: z.array(z.string().min(1)).optional(),
      denyRules: z.array(z.string().min(1)).optional(),
      allowedTools: z.array(z.string().min(1)).optional(),
      disallowedTools: z.array(z.string().min(1)).optional(),
      maxTurns: z.number().int().positive().optional(),
      webSearch: z.boolean().optional(),
      systemPromptOverride: z.string().optional(),
      appendRules: z.string().optional(),
      noPlan: z.boolean().optional(),
      noSubagents: z.boolean().optional(),
      session: sessionOptionsSchema.optional(),
    })
    .strict();

export function validateGrokBuildSettings(
  settings: GrokBuildSettings,
): GrokBuildSettings {
  return grokBuildSettingsSchema.parse(settings);
}

export function validateGrokExecSettings(
  settings: GrokExecSettings,
): GrokExecSettings {
  return grokExecSettingsSchema.parse(settings);
}

function mergeProcessSettings<T extends GrokProcessSettings>(
  base: T,
  override: T,
): T {
  const merged = mergeDefined(base, override);
  return {
    ...merged,
    env:
      base.env || override.env ? { ...base.env, ...override.env } : undefined,
    timeouts:
      base.timeouts || override.timeouts
        ? mergeDefined(base.timeouts ?? {}, override.timeouts ?? {})
        : undefined,
  };
}

export function mergeGrokBuildSettings(
  base: GrokBuildSettings,
  override: GrokBuildSettings = {},
): GrokBuildSettings {
  return validateGrokBuildSettings(mergeProcessSettings(base, override));
}

export function mergeGrokExecSettings(
  base: GrokExecSettings,
  override: GrokExecSettings = {},
): GrokExecSettings {
  return validateGrokExecSettings(mergeProcessSettings(base, override));
}
