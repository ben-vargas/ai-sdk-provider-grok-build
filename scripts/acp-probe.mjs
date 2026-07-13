// ACP probe: drives `grok agent stdio` through initialize -> (authenticate) -> session/new -> session/prompt
// and logs every JSON-RPC message in both directions to an NDJSON trace file.
// Usage: node acp-probe.mjs <traceFile> <cwd> <prompt...>
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';

const [traceFile, workDir, ...promptParts] = process.argv.slice(2);
const promptText = promptParts.join(' ');
writeFileSync(traceFile, '');
const log = (dir, msg) => appendFileSync(traceFile, JSON.stringify({ dir, t: Date.now(), msg }) + '\n');

const proc = spawn('grok', ['--no-auto-update', 'agent', 'stdio'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: workDir });
proc.stderr.on('data', d => appendFileSync(traceFile, JSON.stringify({ dir: 'stderr', t: Date.now(), msg: d.toString() }) + '\n'));

const rl = createInterface({ input: proc.stdout });
const pending = new Map();
let nextId = 1;

function send(obj) {
  log('out', obj);
  proc.stdin.write(JSON.stringify(obj) + '\n');
}
function request(method, params, timeoutMs = 240000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); } });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { appendFileSync(traceFile, JSON.stringify({ dir: 'in-unparsed', t: Date.now(), msg: line }) + '\n'); return; }
  log('in', msg);

  // Agent -> client REQUEST (has id + method): must respond.
  if (msg.method !== undefined && msg.id !== undefined) {
    if (msg.method === 'session/request_permission') {
      const options = msg.params?.options ?? [];
      const allow = options.find(o => /allow|approve|yes/i.test(o.optionId + ' ' + (o.name ?? ''))) ?? options[0];
      send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: allow?.optionId } } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `client does not implement ${msg.method}` } });
    }
    return;
  }
  // Notification (method, no id): already logged.
  if (msg.method !== undefined) return;
  // Response to our request.
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
  else p.resolve(msg.result ?? {});
});

const done = new Promise(r => proc.on('exit', r));
try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
  }, 30000);
  console.log('INIT OK:', JSON.stringify(init).slice(0, 600));

  let sess;
  try {
    sess = await request('session/new', { cwd: workDir, mcpServers: [] }, 60000);
  } catch (e) {
    console.log('session/new failed, trying authenticate:', e.message);
    const method = init.authMethods?.[0]?.id ?? 'cached_token';
    await request('authenticate', { methodId: method }, 120000);
    sess = await request('session/new', { cwd: workDir, mcpServers: [] }, 60000);
  }
  console.log('SESSION:', JSON.stringify(sess).slice(0, 300));

  const result = await request('session/prompt', {
    sessionId: sess.sessionId,
    prompt: [{ type: 'text', text: promptText }],
  });
  console.log('PROMPT RESULT:', JSON.stringify(result).slice(0, 600));
} catch (e) {
  console.error('PROBE ERROR:', e.message);
} finally {
  proc.kill();
  await done;
}
