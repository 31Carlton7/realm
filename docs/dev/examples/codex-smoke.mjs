#!/usr/bin/env node
// Smoke driver for the Codex CLI `app-server` JSON-RPC-over-stdio protocol.
// Companion to ../codex-app-server-protocol.md. No dependencies.
//
//   node codex-smoke.mjs --probe-only
//   node codex-smoke.mjs --cwd /tmp/scratch --prompt "list the files here"
//   node codex-smoke.mjs --interrupt-after 3000 --raw
//
// Flags:
//   --cwd <dir>              working directory for the thread (default: os.tmpdir())
//   --model <id>             model id (default: server default)
//   --prompt <text>          user message for the turn
//   --approval <policy>      untrusted | on-request | never   (default: on-request)
//   --sandbox <mode>         read-only | workspace-write | danger-full-access
//   --interrupt-after <ms>   send turn/interrupt after N ms
//   --probe-only             initialize + getAuthStatus + model/list, then exit
//   --raw                    print every inbound line verbatim
//   --timeout <ms>           overall turn budget (default: 120000)
//
// Approvals are AUTO-ACCEPTED. Only run this against a directory you are happy for
// the model to write to.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = name => argv.includes(`--${name}`);

const opts = {
  cwd: flag('cwd', os.tmpdir()),
  model: flag('model', null),
  prompt: flag('prompt', 'Reply with exactly the word DONE and nothing else.'),
  approval: flag('approval', 'on-request'),
  sandbox: flag('sandbox', 'workspace-write'),
  interruptAfter: flag('interrupt-after', null),
  probeOnly: has('probe-only'),
  raw: has('raw'),
  timeout: Number(flag('timeout', 120000)),
};

const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd });

let killed = false;
const shutdown = () => {
  if (killed) return;
  killed = true;
  try { child.stdin.end(); } catch {}
  try { child.kill('SIGKILL'); } catch {}
};
process.on('exit', shutdown);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shutdown(); process.exit(130); });
child.on('error', err => { console.error('failed to spawn `codex`:', err.message); shutdown(); process.exit(1); });

// stderr is human tracing, never JSON-RPC. Keep it bounded.
child.stderr.on('data', d => { if (opts.raw) process.stderr.write(String(d)); });

let nextId = 1;
const pending = new Map();
const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');
const request = (method, params) => new Promise(resolve => {
  const id = nextId++;
  pending.set(id, resolve);
  send({ jsonrpc: '2.0', id, method, params });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const trim = (v, n = 300) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };

let turnSettled;
const turnDone = new Promise(r => { turnSettled = r; });
const openItems = new Map(); // itemId -> accumulated assistant text

// NOTE: server->client request ids live in their own space and start at 0, so they
// collide with our client ids. They are dispatched by shape, never by id lookup.
readline.createInterface({ input: child.stdout }).on('line', line => {
  if (!line.trim()) return;
  if (opts.raw) console.log('<<', line);
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve?.(msg);
    return;
  }

  if (msg.id !== undefined && msg.method) return onServerRequest(msg);
  onNotification(msg);
});

function onServerRequest(msg) {
  const p = msg.params ?? {};
  switch (msg.method) {
    case 'item/commandExecution/requestApproval':
      console.log(`  [approve] exec ${trim(p.command, 120)}${p.reason ? ` (${p.reason})` : ''}`);
      console.log(`            availableDecisions=${trim(p.availableDecisions, 200)}`);
      return send({ jsonrpc: '2.0', id: msg.id, result: { decision: 'accept' } });
    case 'item/fileChange/requestApproval':
      console.log(`  [approve] patch${p.grantRoot ? ` grantRoot=${p.grantRoot}` : ''}`);
      return send({ jsonrpc: '2.0', id: msg.id, result: { decision: 'accept' } });
    default:
      // Always answer. An unanswered server request stalls the turn forever.
      console.log(`  [server-req] ${msg.method} -> declining (unhandled)`);
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unhandled by codex-smoke' } });
  }
}

function onNotification(msg) {
  const p = msg.params ?? {};
  switch (msg.method) {
    case 'thread/status/changed':
      return console.log(`status: ${p.status?.type}`);
    case 'turn/started':
      return console.log(`turn started: ${p.turn?.id}`);
    case 'item/started':
      if (p.item?.type === 'agentMessage') openItems.set(p.item.id, '');
      return console.log(`item+ ${p.item?.type} ${p.item?.id}`);
    case 'item/agentMessage/delta':
      openItems.set(p.itemId, (openItems.get(p.itemId) ?? '') + p.delta);
      return process.stdout.write(p.delta);
    case 'item/reasoning/summaryTextDelta':
      return process.stdout.write(`\x1b[2m${p.delta}\x1b[0m`);
    case 'item/commandExecution/outputDelta':
      return process.stdout.write(`\x1b[2m${p.delta}\x1b[0m`);
    case 'item/completed': {
      const it = p.item ?? {};
      openItems.delete(it.id);
      if (it.type === 'agentMessage') return console.log(`\nitem- agentMessage: ${trim(it.text)}`);
      if (it.type === 'commandExecution') return console.log(`\nitem- exec ${it.status} exit=${it.exitCode} ${it.durationMs}ms`);
      if (it.type === 'fileChange') return console.log(`\nitem- patch ${it.status}: ${it.changes?.map(c => `${c.kind?.type} ${c.path}`).join(', ')}`);
      return console.log(`\nitem- ${it.type} ${it.id}`);
    }
    case 'thread/tokenUsage/updated': {
      const t = p.tokenUsage?.total ?? {};
      return console.log(`usage: in=${t.inputTokens} (cached ${t.cachedInputTokens}) out=${t.outputTokens} reasoning=${t.reasoningOutputTokens} total=${t.totalTokens} / ctx ${p.tokenUsage?.modelContextWindow}`);
    }
    case 'turn/completed':
      console.log(`turn ${p.turn?.status} in ${p.turn?.durationMs}ms`);
      // Interrupts skip item/completed — force-close anything still open.
      for (const [id, text] of openItems) console.log(`  (unterminated ${id}: ${trim(text, 80)})`);
      openItems.clear();
      return turnSettled();
    case 'error':
      console.error(`error: ${p.error?.message} (willRetry=${p.willRetry})`);
      return turnSettled();
    case 'warning':
    case 'configWarning':
      return console.error(`warning: ${p.message ?? p.summary}`);
    case 'mcpServer/startupStatus/updated':
      return console.log(`mcp ${p.name}: ${p.status}${p.error ? ` (${p.error})` : ''}`);
    default:
      return; // rawResponse/*, rateLimits, fuzzyFileSearch/*, …
  }
}

const die = (label, res) => {
  console.error(`${label} failed:`, JSON.stringify(res.error));
  if (res.error?.data?.action === 'relogin') console.error('  -> run `codex login`');
  shutdown();
  process.exit(1);
};

try {
  const init = await request('initialize', {
    clientInfo: { name: 'realm-smoke', title: 'Realm smoke test', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  if (init.error) die('initialize', init);
  send({ jsonrpc: '2.0', method: 'initialized' });
  console.log(`initialized: ${init.result.userAgent}`);
  console.log(`codexHome:   ${init.result.codexHome}`);

  const auth = await request('getAuthStatus', { includeToken: false, refreshToken: false });
  console.log(`auth:        ${auth.result ? `${auth.result.authMethod ?? 'NOT LOGGED IN'} (requiresOpenaiAuth=${auth.result.requiresOpenaiAuth})` : JSON.stringify(auth.error)}`);

  if (opts.probeOnly) {
    const models = await request('model/list', {});
    for (const m of models.result?.data ?? []) console.log(`model:       ${m.id}${m.isDefault ? ' (default)' : ''} — ${m.displayName}`);
    shutdown();
    process.exit(0);
  }

  const started = await request('thread/start', {
    cwd: opts.cwd,
    ...(opts.model ? { model: opts.model } : {}),
    approvalPolicy: opts.approval,
    sandbox: opts.sandbox, // string on thread/start; turn/start uses `sandboxPolicy` (object)
  });
  if (started.error) die('thread/start', started);
  const threadId = started.result.thread.id;
  console.log(`thread:      ${threadId} (model=${started.result.model}, cwd=${started.result.cwd})`);

  const turn = await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: opts.prompt, text_elements: [] }], // text_elements is required
  });
  if (turn.error) die('turn/start', turn);
  const turnId = turn.result.turn.id;
  console.log(`turn:        ${turnId}\n---`);

  if (opts.interruptAfter) {
    setTimeout(async () => {
      console.log(`\n[interrupting after ${opts.interruptAfter}ms]`);
      console.log('interrupt ->', JSON.stringify((await request('turn/interrupt', { threadId, turnId })).result));
    }, Number(opts.interruptAfter));
  }

  await Promise.race([turnDone, sleep(opts.timeout).then(() => console.error('\n[timeout]'))]);

  const resumed = await request('thread/resume', { threadId });
  if (resumed.result) console.log(`resume:      ok, ${resumed.result.thread.turns.length} turn(s) on disk`);
} catch (err) {
  console.error('smoke failed:', err);
  shutdown();
  process.exit(1);
}

shutdown();
process.exit(0);
