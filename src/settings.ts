import { z } from "zod";
import type { PermissionMode } from "./acp/client.js";
import type { AcpMcpServer } from "./acp/protocol.js";

export interface GrokBuildLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type GrokBuildAuthMethod = "cached_token" | "api_key" | (string & {});

export interface GrokBuildTimeouts {
  requestMs?: number;
  promptMs?: number;
}

export interface GrokBuildSettings {
  executablePath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  authMethod?: GrokBuildAuthMethod;
  permissionMode?: PermissionMode;
  defaultModel?: string;
  mcpServers?: AcpMcpServer[];
  timeouts?: GrokBuildTimeouts;
  logger?: GrokBuildLogger;
  includeRawChunks?: boolean;
}

export interface GrokBuildSessionOptions {
  id?: string;
  resume?: string;
  continue?: boolean;
  fork?: boolean;
}

export interface GrokBuildProviderOptions {
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  session?: GrokBuildSessionOptions;
  permissionMode?: PermissionMode;
  mcpServers?: AcpMcpServer[];
  maxTurns?: number;
  includeExtensionEvents?: boolean;
}

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

export const grokBuildSettingsSchema: z.ZodType<GrokBuildSettings> = z
  .object({
    executablePath: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string().optional()).optional(),
    authMethod: z.string().min(1).optional(),
    permissionMode: z.enum(["default", "bypassPermissions"]).optional(),
    defaultModel: z.string().min(1).optional(),
    mcpServers: z.array(grokBuildMcpServerSchema).optional(),
    timeouts: z
      .object({
        requestMs: z.number().int().positive().optional(),
        promptMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    logger: loggerSchema.optional(),
    includeRawChunks: z.boolean().optional(),
  })
  .strict();

const sessionOptionsSchema = z
  .object({
    id: z.string().min(1).optional(),
    resume: z.string().min(1).optional(),
    continue: z.boolean().optional(),
    fork: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.id !== undefined && value.resume !== undefined) {
      context.addIssue({
        code: "custom",
        message: "session.id and session.resume are mutually exclusive",
      });
    }
  });

export const grokBuildProviderOptionsSchema: z.ZodType<GrokBuildProviderOptions> =
  z
    .object({
      model: z.string().min(1).optional(),
      reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
      session: sessionOptionsSchema.optional(),
      permissionMode: z.enum(["default", "bypassPermissions"]).optional(),
      mcpServers: z.array(grokBuildMcpServerSchema).optional(),
      maxTurns: z.number().int().positive().optional(),
      includeExtensionEvents: z.boolean().optional(),
    })
    .strict();

export function validateGrokBuildSettings(
  settings: GrokBuildSettings,
): GrokBuildSettings {
  return grokBuildSettingsSchema.parse(settings);
}

export function mergeGrokBuildSettings(
  base: GrokBuildSettings,
  override: GrokBuildSettings = {},
): GrokBuildSettings {
  return validateGrokBuildSettings({
    ...base,
    ...override,
    env:
      base.env || override.env ? { ...base.env, ...override.env } : undefined,
    timeouts:
      base.timeouts || override.timeouts
        ? { ...base.timeouts, ...override.timeouts }
        : undefined,
  });
}
