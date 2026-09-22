import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { createRequire } from "node:module";
import { abortError, waitAbortably } from "./abort.js";
import { GrokCliError } from "./errors.js";

export type GrokCommandSource = "explicit" | "package" | "path" | "npx";

export interface ResolvedGrokCommand {
  command: string;
  prefixArgs: string[];
  source: GrokCommandSource;
}

export interface ResolveGrokCommandOptions {
  executablePath?: string;
  allowPackageBin?: boolean;
  allowNpx?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface GrokVersionCheckOptions extends ResolveGrokCommandOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const versionChecks = new Map<string, Promise<string>>();
const DEFAULT_VERSION_TIMEOUT_MS = 30_000;
const VERSION_TERMINATE_GRACE_MS = 500;
const VERSION_KILL_GRACE_MS = 250;
const GROK_CLI_ABORT_MESSAGE = "The operation was aborted.";

async function executable(path: string): Promise<boolean> {
  try {
    await fs.access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (isAbsolute(name) || name.includes("/")) {
    return (await executable(name)) ? name : undefined;
  }
  const directories = (env.PATH ?? process.env.PATH ?? "").split(delimiter);
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of directories) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (
        process.platform === "win32" &&
        [".cmd", ".bat"].includes(extname(candidate).toLowerCase())
      ) {
        continue;
      }
      if (await executable(candidate)) return candidate;
    }
  }
  return undefined;
}

function assertSupportedLauncher(
  command: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (
    platform === "win32" &&
    [".cmd", ".bat"].includes(extname(command).toLowerCase())
  ) {
    throw new GrokCliError(
      `Windows command-script launcher '${command}' is not supported. Install a native grok executable on PATH or set executablePath to one.`,
      { code: "GROK_CLI_WINDOWS_SCRIPT_UNSUPPORTED" },
    );
  }
}

async function resolvePackageBin(cwd: string): Promise<string | undefined> {
  try {
    const consumerRequire = createRequire(resolve(cwd, "package.json"));
    const packageJsonPath = consumerRequire.resolve(
      "@xai-official/grok/package.json",
    );
    const packageJson = JSON.parse(
      await fs.readFile(packageJsonPath, "utf8"),
    ) as { bin?: string | Record<string, string> };
    const relativeBin =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin?.grok;
    if (!relativeBin) return undefined;
    const candidate = resolve(dirname(packageJsonPath), relativeBin);
    return (await executable(candidate)) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve Grok without silently downloading or updating anything. */
export async function resolveGrokCommand(
  options: ResolveGrokCommandOptions = {},
): Promise<ResolvedGrokCommand> {
  const cwd = options.cwd ?? process.cwd();
  const env = { ...process.env, ...options.env };
  if (options.executablePath) {
    assertSupportedLauncher(options.executablePath);
    return {
      command: options.executablePath,
      prefixArgs: [],
      source: "explicit",
    };
  }
  if (options.allowPackageBin && process.platform !== "win32") {
    const packageBin = await resolvePackageBin(cwd);
    if (packageBin) {
      return { command: packageBin, prefixArgs: [], source: "package" };
    }
  }
  const pathBin = await findOnPath("grok", env);
  if (pathBin) {
    assertSupportedLauncher(pathBin);
    return { command: pathBin, prefixArgs: [], source: "path" };
  }
  if (options.allowNpx) {
    if (process.platform === "win32") {
      throw new GrokCliError(
        "The npx fallback is not supported on Windows. Install a native grok executable on PATH or set executablePath to one.",
        { code: "GROK_CLI_WINDOWS_NPX_UNSUPPORTED" },
      );
    }
    const npx = await findOnPath("npx", env);
    if (npx) {
      assertSupportedLauncher(npx);
      return {
        command: npx,
        prefixArgs: ["-y", "@xai-official/grok@^1"],
        source: "npx",
      };
    }
  }
  throw new GrokCliError(
    "Could not find Grok CLI 1.x. Put 'grok' on PATH, set executablePath, explicitly trust cwd package discovery with allowPackageBin, or enable allowNpx on non-Windows platforms.",
    { code: "GROK_CLI_NOT_FOUND" },
  );
}

function collectVersion(
  command: ResolvedGrokCommand,
  options: GrokVersionCheckOptions,
): Promise<string> {
  return new Promise<string>((resolveVersion, reject) => {
    const child = spawn(
      command.command,
      [...command.prefixArgs, "--no-auto-update", "--version"],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
    const timeoutFailure = (): GrokCliError =>
      new GrokCliError(
        `Grok CLI version check timed out after ${String(timeoutMs)}ms.`,
        { code: "GROK_CLI_VERSION_CHECK_TIMEOUT", stderr },
      );
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      callback();
    };
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, VERSION_TERMINATE_GRACE_MS);
      settleTimer = setTimeout(() => {
        finish(() => reject(timeoutFailure()));
      }, VERSION_TERMINATE_GRACE_MS + VERSION_KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (stdout.length < 4096) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 4096) stderr += String(chunk);
    });
    child.once("error", (cause) =>
      finish(() =>
        reject(
          new GrokCliError(`Failed to run Grok CLI: ${cause.message}`, {
            code:
              (cause as NodeJS.ErrnoException).code ?? "GROK_CLI_SPAWN_FAILED",
            cause,
          }),
        ),
      ),
    );
    child.once("close", (exitCode) => {
      if (timedOut) {
        finish(() => reject(timeoutFailure()));
        return;
      }
      if (exitCode !== 0) {
        finish(() =>
          reject(
            new GrokCliError(
              `Grok CLI version check failed with exit code ${String(exitCode)}.`,
              { code: "GROK_CLI_VERSION_CHECK_FAILED", exitCode, stderr },
            ),
          ),
        );
        return;
      }
      const match = `${stdout}\n${stderr}`.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
      if (!match) {
        finish(() =>
          reject(
            new GrokCliError(
              "Grok CLI returned an unrecognized version string.",
              {
                code: "GROK_CLI_VERSION_UNKNOWN",
                stderr,
              },
            ),
          ),
        );
        return;
      }
      if (Number(match[1]) < 1) {
        finish(() =>
          reject(
            new GrokCliError(
              `Unsupported Grok CLI ${match[0]}; this provider requires Grok CLI >=1.0.0.`,
              { code: "UNSUPPORTED_GROK_CLI_VERSION" },
            ),
          ),
        );
        return;
      }
      finish(() => resolveVersion(match[0]));
    });
  });
}

/** Validate a resolved command once per process-affecting command identity. */
export async function ensureGrokCliVersion(
  command: ResolvedGrokCommand,
  options: GrokVersionCheckOptions = {},
): Promise<string> {
  if (options.signal?.aborted)
    throw abortError(options.signal, GROK_CLI_ABORT_MESSAGE);
  assertSupportedLauncher(command.command);
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const key = JSON.stringify([
    command.command,
    command.prefixArgs,
    options.cwd,
    options.env?.PATH,
    timeoutMs,
  ]);
  let check = versionChecks.get(key);
  if (!check) {
    check = collectVersion(command, {
      ...options,
      signal: undefined,
      timeoutMs,
    });
    versionChecks.set(key, check);
    void check.catch(() => versionChecks.delete(key));
  }
  return await waitAbortably(check, options.signal, GROK_CLI_ABORT_MESSAGE);
}

export function clearGrokVersionCacheForTests(): void {
  versionChecks.clear();
}
