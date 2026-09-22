import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGrokAgent,
  createGrokExec,
  ensureGrokCliVersion,
  resolveGrokCommand,
} from "../dist/index.js";
import { toolInputContainsMarker } from "./live-smoke-input.mjs";

if (process.env.CI) {
  throw new Error(
    "test:live is an authenticated local smoke test and must not run in CI.",
  );
}

function callOptions(text) {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

function generatedText(result) {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function assertSentinel(result, sentinel, mode) {
  const text = generatedText(result);
  if (!text.includes(sentinel)) {
    throw new Error(
      `${mode} smoke test did not return ${sentinel}; received ${JSON.stringify(text)}.`,
    );
  }
}

function assertHeadlessUsage(usage) {
  const { total, noCache, cacheRead, cacheWrite } = usage.inputTokens;
  if (typeof total !== "number" || total < 0) {
    throw new Error("Headless smoke test did not return a valid input total.");
  }
  const components = [noCache, cacheRead, cacheWrite].filter(
    (value) => typeof value === "number",
  );
  if (
    components.length > 0 &&
    components.reduce((sum, value) => sum + value, 0) !== total
  ) {
    throw new Error(
      `Headless usage is inconsistent: total=${String(total)}, components=${components.join("+")}.`,
    );
  }
}

const directory = await mkdtemp(join(tmpdir(), "grok-provider-live-"));
let agent;

try {
  const command = await resolveGrokCommand({ cwd: directory });
  const version = await ensureGrokCliVersion(command, { cwd: directory });
  console.log(`Verified Grok CLI ${version} (${command.command}).`);

  const exec = createGrokExec({
    defaultSettings: {
      cwd: directory,
      noSubagents: true,
      webSearch: false,
      timeouts: { promptMs: 120_000 },
    },
  });
  const execResult = await exec().doGenerate(
    callOptions("Reply with exactly GROK_EXEC_LIVE_OK and nothing else."),
  );
  assertSentinel(execResult, "GROK_EXEC_LIVE_OK", "grokExec");
  assertHeadlessUsage(execResult.usage);
  console.log("grokExec generation and native usage invariants passed.");

  const permissionMarker = join(directory, "permission-bypass-marker");
  const permissionResult = await exec().doGenerate(
    callOptions(
      `Use the shell tool exactly once to run this exact command, then briefly report whether it was allowed. Do not ask the user a question: node -e "require('node:fs').writeFileSync(process.argv[1], 'allowed')" ${JSON.stringify(permissionMarker)}`,
    ),
  );
  const toolCall = permissionResult.content.find(
    (part) =>
      part.type === "tool-call" &&
      part.providerExecuted === true &&
      toolInputContainsMarker(part.input, permissionMarker),
  );
  if (!toolCall) {
    throw new Error(
      "grokExec permission smoke test did not emit the marker-writing tool call.",
    );
  }
  const toolResult = permissionResult.content.find(
    (part) =>
      part.type === "tool-result" &&
      part.toolCallId === toolCall.toolCallId &&
      part.preliminary !== true,
  );
  if (!toolResult || toolResult.isError !== true) {
    throw new Error(
      "grokExec permission smoke test did not return a denied final result for the marker-writing tool call.",
    );
  }
  try {
    await access(permissionMarker);
    throw new Error(
      "grokExec permission smoke test allowed the shell command to create its marker.",
    );
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }
  console.log(
    "grokExec denied the permission-requiring tool under implicit dontAsk mode.",
  );

  agent = createGrokAgent({
    defaultSettings: {
      cwd: directory,
      timeouts: { promptMs: 120_000 },
    },
  });
  const acpResult = await agent().doGenerate(
    callOptions("Reply with exactly GROK_ACP_LIVE_OK and nothing else."),
  );
  assertSentinel(acpResult, "GROK_ACP_LIVE_OK", "pooled ACP");
  console.log("Pooled ACP generation passed.");
} catch (error) {
  throw new Error(
    `Live Grok smoke test failed. Confirm that Grok CLI >=1.0.0 is installed and authenticated with \`grok login\`. ${
      error instanceof Error ? error.message : String(error)
    }`,
    { cause: error },
  );
} finally {
  try {
    await agent?.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

console.log("Authenticated Grok live smoke test passed.");
