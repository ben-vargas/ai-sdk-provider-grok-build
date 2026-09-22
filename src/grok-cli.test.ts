import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGrokVersionCacheForTests,
  ensureGrokCliVersion,
  resolveGrokCommand,
} from "./grok-cli.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), "grok-resolver-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function executable(path: string, source: string): Promise<void> {
  await fs.writeFile(path, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  await fs.chmod(path, 0o755);
}

async function nodeScript(directory: string, name: string, source: string) {
  const script = join(directory, `${name}.cjs`);
  await fs.writeFile(script, `${source}\n`);
  return {
    command: process.execPath,
    prefixArgs: [script],
    source: "explicit" as const,
  };
}

afterEach(async () => {
  clearGrokVersionCacheForTests();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("Grok CLI resolution", () => {
  it("gives an explicit executable highest precedence", async () => {
    const resolved = await resolveGrokCommand({
      executablePath: "/explicit/grok",
      allowNpx: true,
      env: { PATH: "" },
    });
    expect(resolved).toEqual({
      command: "/explicit/grok",
      prefixArgs: [],
      source: "explicit",
    });
  });

  it.skipIf(process.platform === "win32")(
    "resolves a consumer-installed package bin and executes it directly",
    async () => {
      const cwd = await temporaryDirectory();
      const packageDirectory = join(
        cwd,
        "node_modules",
        "@xai-official",
        "grok",
      );
      await fs.mkdir(join(packageDirectory, "bin"), { recursive: true });
      await fs.writeFile(
        join(packageDirectory, "package.json"),
        JSON.stringify({
          name: "@xai-official/grok",
          bin: { grok: "bin/grok" },
        }),
      );
      const binary = join(packageDirectory, "bin", "grok");
      await executable(binary, 'console.log("grok 1.0.34")');

      await expect(
        resolveGrokCommand({ cwd, env: { PATH: "" } }),
      ).rejects.toMatchObject({ code: "GROK_CLI_NOT_FOUND" });
      const resolved = await resolveGrokCommand({
        cwd,
        env: { PATH: "" },
        allowPackageBin: true,
      });
      expect(resolved).toEqual({
        command: await fs.realpath(binary),
        prefixArgs: [],
        source: "package",
      });
      await expect(ensureGrokCliVersion(resolved, { cwd })).resolves.toBe(
        "1.0.34",
      );
    },
  );

  it("falls back to PATH before opt-in npx", async () => {
    const directory = await temporaryDirectory();
    const grok = join(
      directory,
      process.platform === "win32" ? "grok.EXE" : "grok",
    );
    const npx = join(
      directory,
      process.platform === "win32" ? "npx.EXE" : "npx",
    );
    await executable(grok, 'console.log("grok 1.2.3")');
    await executable(npx, 'console.log("npx should not run")');
    await expect(
      resolveGrokCommand({
        cwd: directory,
        allowNpx: true,
        env: { PATH: directory },
      }),
    ).resolves.toMatchObject({ command: grok, source: "path" });
  });

  it.skipIf(process.platform === "win32")(
    "uses npx only when explicitly opted in",
    async () => {
      const directory = await temporaryDirectory();
      const npx = join(directory, "npx");
      await executable(npx, 'console.log("grok 1.0.34")');
      await expect(
        resolveGrokCommand({ cwd: directory, env: { PATH: directory } }),
      ).rejects.toMatchObject({ code: "GROK_CLI_NOT_FOUND" });
      await expect(
        resolveGrokCommand({
          cwd: directory,
          env: { PATH: directory },
          allowNpx: true,
        }),
      ).resolves.toEqual({
        command: npx,
        prefixArgs: ["-y", "@xai-official/grok@^1"],
        source: "npx",
      });
    },
  );

  it("rejects pre-1.0 and unrecognized CLI versions with typed errors", async () => {
    const directory = await temporaryDirectory();
    const old = await nodeScript(
      directory,
      "old-grok",
      'console.log("grok 0.2.121")',
    );
    const unknown = await nodeScript(
      directory,
      "unknown-grok",
      'console.log("development")',
    );
    await expect(ensureGrokCliVersion(old)).rejects.toMatchObject({
      code: "UNSUPPORTED_GROK_CLI_VERSION",
    });
    await expect(ensureGrokCliVersion(unknown)).rejects.toMatchObject({
      code: "GROK_CLI_VERSION_UNKNOWN",
    });
  });

  it("reports version process exits and spawn failures", async () => {
    const directory = await temporaryDirectory();
    const failing = await nodeScript(
      directory,
      "failing-grok",
      "process.stderr.write('failed'); process.exit(7)",
    );
    await expect(ensureGrokCliVersion(failing)).rejects.toMatchObject({
      code: "GROK_CLI_VERSION_CHECK_FAILED",
      exitCode: 7,
      stderr: "failed",
    });
    await expect(
      ensureGrokCliVersion({
        command: join(directory, "missing"),
        prefixArgs: [],
        source: "explicit",
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for close so late version output is included", async () => {
    const directory = await temporaryDirectory();
    const command = await nodeScript(
      directory,
      "late-version",
      "process.on('exit', () => require('node:fs').writeSync(1, 'grok 1.2.7\\n'))",
    );
    await expect(ensureGrokCliVersion(command)).resolves.toBe("1.2.7");
  });

  it("times out a hung version check", async () => {
    const directory = await temporaryDirectory();
    const command = await nodeScript(
      directory,
      "hung-version",
      "process.stderr.write('still waiting'); setInterval(() => undefined, 1000)",
    );
    await expect(
      ensureGrokCliVersion(command, { timeoutMs: 500 }),
    ).rejects.toMatchObject({
      code: "GROK_CLI_VERSION_CHECK_TIMEOUT",
      message: "Grok CLI version check timed out after 500ms.",
      stderr: "still waiting",
    });
  });

  it("isolates one caller aborting a shared version check", async () => {
    const directory = await temporaryDirectory();
    const resolved = await nodeScript(
      directory,
      "shared-version",
      "setTimeout(() => console.log('grok 1.4.0'), 30)",
    );
    const controller = new AbortController();
    const first = ensureGrokCliVersion(resolved, {
      timeoutMs: 500,
      signal: controller.signal,
    });
    const second = ensureGrokCliVersion(resolved, { timeoutMs: 500 });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toBe("1.4.0");
  });

  it("rejects Windows command scripts and disables the npx fallback", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await expect(
        resolveGrokCommand({ executablePath: "C:/bin/grok.cmd" }),
      ).rejects.toMatchObject({
        code: "GROK_CLI_WINDOWS_SCRIPT_UNSUPPORTED",
      });
      await expect(
        resolveGrokCommand({ allowNpx: true, env: { PATH: "" } }),
      ).rejects.toMatchObject({ code: "GROK_CLI_WINDOWS_NPX_UNSUPPORTED" });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("skips an earlier Windows script shim and continues to a native binary", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    const script = join(first, "grok.CMD");
    const native = join(second, "grok.EXE");
    await executable(script, 'console.log("script")');
    await executable(native, 'console.log("native")');
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await expect(
        resolveGrokCommand({
          env: {
            PATH: [first, second].join(delimiter),
            PATHEXT: ".CMD;.EXE",
          },
        }),
      ).resolves.toMatchObject({ command: native, source: "path" });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("honors normal PATH delimiter semantics", () => {
    expect(delimiter).toMatch(/^[:;]$/);
  });
});
