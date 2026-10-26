// ACP scenario captures for unproven flows: permission prompts, session restart/load,
// cancellation ordering. Logs every JSON-RPC message both directions to an NDJSON trace.
// Usage: node acp-scenarios.mjs <scenario> <traceFile> <cwd>
//   scenario: permission-allow | permission-deny | restart-load | cancel
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";

const [scenario, traceFile, workDir] = process.argv.slice(2);
writeFileSync(traceFile, "");
const log = (dir, msg) =>
  appendFileSync(traceFile, JSON.stringify({ dir, t: Date.now(), msg }) + "\n");
const note = (s) => {
  console.log(`[${scenario}] ${s}`);
  appendFileSync(
    traceFile,
    JSON.stringify({ dir: "note", t: Date.now(), msg: s }) + "\n",
  );
};

function makeClient(extraArgs = []) {
  const proc = spawn(
    "grok",
    ["--no-auto-update", ...extraArgs, "agent", "stdio"],
    { stdio: ["pipe", "pipe", "pipe"], cwd: workDir },
  );
  proc.stderr.on("data", (d) =>
    appendFileSync(
      traceFile,
      JSON.stringify({ dir: "stderr", t: Date.now(), msg: d.toString() }) +
        "\n",
    ),
  );
  const rl = createInterface({ input: proc.stdout });
  const pending = new Map();
  const updateListeners = new Set();
  let nextId = 1;
  let onPermission = null; // async (params) => result

  const send = (obj) => {
    log("out", obj);
    proc.stdin.write(JSON.stringify(obj) + "\n");
  };
  const request = (method, params, timeoutMs = 300000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      appendFileSync(
        traceFile,
        JSON.stringify({ dir: "in-unparsed", t: Date.now(), msg: line }) + "\n",
      );
      return;
    }
    log("in", msg);
    if (msg.method !== undefined && msg.id !== undefined) {
      if (msg.method === "session/request_permission" && onPermission) {
        Promise.resolve(onPermission(msg.params)).then((result) =>
          send({ jsonrpc: "2.0", id: msg.id, result }),
        );
      } else {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32601,
            message: `client does not implement ${msg.method}`,
          },
        });
      }
      return;
    }
    if (msg.method !== undefined) {
      if (msg.method === "session/update")
        for (const l of updateListeners) l(msg.params);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result ?? {});
  });

  return {
    proc,
    request,
    notify,
    setPermissionHandler: (h) => {
      onPermission = h;
    },
    onUpdate: (l) => updateListeners.add(l),
    async init() {
      return request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        30000,
      );
    },
    async dispose() {
      proc.kill();
      await new Promise((r) => proc.on("exit", r));
    },
  };
}

if (scenario === "permission-allow" || scenario === "permission-deny") {
  // Override the user's global always-approve via --permission-mode default.
  const c = makeClient(["--permission-mode", "default"]);
  c.setPermissionHandler((params) => {
    const options = params?.options ?? [];
    note(`permission requested; options=${JSON.stringify(options)}`);
    const pick =
      scenario === "permission-allow"
        ? (options.find((o) =>
            /allow|approve|yes/i.test(o.optionId + " " + (o.name ?? "")),
          ) ?? options[0])
        : (options.find((o) =>
            /reject|deny|no/i.test(o.optionId + " " + (o.name ?? "")),
          ) ?? options[options.length - 1]);
    note(`answering with optionId=${pick?.optionId}`);
    return { outcome: { outcome: "selected", optionId: pick?.optionId } };
  });
  await c.init();
  const sess = await c.request(
    "session/new",
    { cwd: workDir, mcpServers: [] },
    60000,
  );
  const result = await c.request("session/prompt", {
    sessionId: sess.sessionId,
    prompt: [
      {
        type: "text",
        text: "Use your file editing tool (create_file or edit_file — NOT the terminal) to create a file named edited-by-grok.txt containing exactly: permission-fixture. Then confirm.",
      },
    ],
  });
  note(`stopReason=${result.stopReason}`);
  await c.dispose();
} else if (scenario === "restart-load") {
  const c1 = makeClient();
  c1.setPermissionHandler(() => ({
    outcome: { outcome: "selected", optionId: "allow" },
  }));
  await c1.init();
  const sess = await c1.request(
    "session/new",
    { cwd: workDir, mcpServers: [] },
    60000,
  );
  const r1 = await c1.request("session/prompt", {
    sessionId: sess.sessionId,
    prompt: [
      {
        type: "text",
        text: "Remember this codeword: kumquat-42. Reply only: OK",
      },
    ],
  });
  note(`first prompt stopReason=${r1.stopReason}; killing process`);
  await c1.dispose();

  const c2 = makeClient();
  c2.setPermissionHandler(() => ({
    outcome: { outcome: "selected", optionId: "allow" },
  }));
  let replayed = 0;
  c2.onUpdate(() => {
    replayed++;
  });
  await c2.init();
  note(`calling session/load for ${sess.sessionId}`);
  const loadResult = await c2.request(
    "session/load",
    { sessionId: sess.sessionId, cwd: workDir, mcpServers: [] },
    120000,
  );
  note(
    `session/load result=${JSON.stringify(loadResult).slice(0, 400)}; updates during load=${replayed}`,
  );
  const r2 = await c2.request("session/prompt", {
    sessionId: sess.sessionId,
    prompt: [
      {
        type: "text",
        text: "What was the codeword? Reply with just the codeword.",
      },
    ],
  });
  note(`second prompt stopReason=${r2.stopReason}`);
  await c2.dispose();
} else if (scenario === "cancel") {
  const c = makeClient();
  c.setPermissionHandler(() => ({
    outcome: { outcome: "selected", optionId: "allow" },
  }));
  let chunks = 0;
  let cancelSent = false;
  await c.init();
  const sess = await c.request(
    "session/new",
    { cwd: workDir, mcpServers: [] },
    60000,
  );
  c.onUpdate((u) => {
    if (
      u?.update?.sessionUpdate === "agent_message_chunk" ||
      u?.update?.sessionUpdate === "agent_thought_chunk"
    ) {
      chunks++;
      if (chunks === 5 && !cancelSent) {
        cancelSent = true;
        note("sending session/cancel notification after 5 chunks");
        c.notify("session/cancel", { sessionId: sess.sessionId });
      }
    }
  });
  const result = await c.request("session/prompt", {
    sessionId: sess.sessionId,
    prompt: [
      {
        type: "text",
        text: "Write out the numbers one through two hundred as English words, one per line. Do not use tools.",
      },
    ],
  });
  note(
    `prompt resolved with stopReason=${result.stopReason}; chunks seen before+after cancel=${chunks}`,
  );
  await c.dispose();
} else {
  console.error("unknown scenario", scenario);
  process.exit(1);
}
note("scenario complete");
