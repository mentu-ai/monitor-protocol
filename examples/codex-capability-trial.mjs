#!/usr/bin/env node
/** Real, no-inference MCP admission trial through an owned Codex app-server child.
 * node examples/codex-capability-trial.mjs --codex /absolute/codex --state /new/private/directory
 * Creates an isolated CODEX_HOME and an ephemeral thread; stops only its owned child.
 * This establishes fresh session tool dispatch, not model tool selection or desktop parity.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { capabilityDigest, CodexAppServerCapabilities, admitWorkspaceCapabilityWork } from '../dist/index.js';

process.umask(0o077);
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--codex' || args[2] !== '--state' || !isAbsolute(args[1]) || !isAbsolute(args[3]))
  throw new Error('Expected --codex ABSOLUTE_BINARY --state NEW_ABSOLUTE_DIRECTORY');
const binary = realpathSync(args[1]), state = args[3];
mkdirSync(state, { mode: 0o700 }); // Refuse reuse, including a previous incomplete trial.
const home = join(state, 'codex-home'), workspace = join(state, 'workspace');
mkdirSync(home, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
const executableSha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'codex-capability-fixture.mjs');
const config = { mcp_servers: { continuity_fixture: { command: process.execPath,
  args: [fixturePath], required: true, enabled_tools: ['read_probe'] } },
  web_search: 'disabled', features: { apps: false }, model_reasoning_effort: 'low' };
// A fixed config in the isolated home prevents inheriting user MCP servers or app credentials.
writeFileSync(join(home, 'config.toml'), `approval_policy = "never"\nsandbox_mode = "read-only"\n`, { mode: 0o600 });
const cancellation = new AbortController();
const pending = new Map();
let cancellationSignal = null, transportClosing = false;
function rejectAll(message = 'Owned Codex transport closed') {
  for (const item of pending.values()) item.reject(new Error(message));
  pending.clear();
}
function cancel(signal) {
  if (cancellationSignal) return; // Repeated signals cannot interrupt owned-child cleanup.
  cancellationSignal = signal;
  cancellation.abort();
  rejectAll('trial_cancelled');
}
const onSigint = () => cancel('SIGINT'), onSigterm = () => cancel('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);
const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
  cwd: workspace, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME,
    CODEX_HOME: home, LANG: 'en_US.UTF-8' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const runtimeId = randomUUID();
let nextId = 1, stopped = false, stderrBytes = 0;
child.stderr.on('data', data => { stderrBytes += data.length; }); // Never publish raw diagnostic data.
child.once('error', () => { if (!child.pid) stopped = true; rejectAll(); });
child.once('exit', () => { stopped = true; rejectAll(); });
child.stdin.on('error', () => rejectAll());
child.stdout.on('error', () => rejectAll());
child.stderr.on('error', () => rejectAll());
function assertActive() {
  if (cancellation.signal.aborted) throw new Error('trial_cancelled');
  if (stopped || transportClosing) throw new Error('Owned Codex runtime stopped');
}
const lines = createInterface({ input: child.stdout });
lines.on('error', () => rejectAll());
lines.on('line', line => {
  if (cancellation.signal.aborted || transportClosing) return;
  if (line.length > 2_000_000) { rejectAll(); return; }
  let message;
  try { message = JSON.parse(line); } catch { rejectAll(); return; }
  if (message.method && message.id !== undefined) {
    // This trial never approves model requests, executes dynamic tools or answers elicitation.
    child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'No interactive request handler in this trial' } }) + '\n');
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  message.error ? waiter.reject(new Error('Owned Codex RPC refused ' + waiter.method)) : waiter.resolve(message.result);
});
async function request(method, params, { signal = AbortSignal.timeout(15_000) } = {}) {
  assertActive();
  signal.throwIfAborted();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); reject(new Error('Owned Codex RPC timed out or cancelled')); };
    const finish = fn => value => { signal.removeEventListener('abort', abort); fn(value); };
    pending.set(id, { method, resolve: finish(resolve), reject: finish(reject) });
    signal.addEventListener('abort', abort, { once: true });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
let output;
try {
  await request('initialize', { clientInfo: { name: 'mentu_capability_trial', version: '1' }, capabilities: { experimentalApi: true } });
  assertActive();
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const started = await request('thread/start', { cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only',
    ephemeral: true, config });
  const threadId = started?.thread?.id;
  if (typeof threadId !== 'string' || started.cwd !== workspace) throw new Error('Thread binding not established');
  const binding = { provider: 'codex', sessionId: threadId, runtimeId,
    configSha256: capabilityDigest({ config, executableSha256, cwd: started.cwd, model: started.model,
      approvalPolicy: started.approvalPolicy, sandbox: started.sandbox }), workspace };
  let successfulProbeCalls = 0;
  const adapter = new CodexAppServerCapabilities({ request: async (method, params, options) => {
    const response = await request(method, params, options);
    if (method === 'mcpServer/tool/call') successfulProbeCalls++;
    return response;
  } }, async signal => {
    assertActive();
    signal.throwIfAborted();
    if (stopped) throw new Error('Runtime stopped');
    const current = await request('thread/read', { threadId, includeTurns: false }, { signal });
    if (current.thread?.id !== threadId || current.thread?.status?.type !== 'idle') throw new Error('Bound thread is no longer idle');
    return { ...binding }; // This host owns its immutable config and only one stdio connection.
  });
  // Pin the fixture contract before discovery; do not trust-on-first-use a runtime catalog.
  const pinnedTool = { name: 'read_probe', description: 'Read the fixed continuity probe.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const profile = { version: 1, id: 'continuity-fixture-v1', ttlMs: 30_000, timeoutMs: 15_000,
    required: [{ id: 'fixture.identity', server: 'continuity_fixture', tool: 'read_probe',
      toolSha256: capabilityDigest(pinnedTool), probe: { kind: 'read-only', arguments: {},
        assertions: [{ path: '/structuredContent/fixture', equals: 'continuity-v1' }] } },
      { id: 'fixture.total', server: 'continuity_fixture', tool: 'read_probe',
        toolSha256: capabilityDigest(pinnedTool), probe: { kind: 'read-only', arguments: {},
          assertions: [{ path: '/structuredContent/total', equals: 64 }] } }] };
  const workspaceProfile = { version: 1, id: profile.id, ttlMs: profile.ttlMs, timeoutMs: profile.timeoutMs,
    required: ['fixture.identity', 'fixture.total'], providers: { codex: profile.required } };
  const admitted = await admitWorkspaceCapabilityWork(workspaceProfile, binding, adapter, () => {
    assertActive();
    return { admitted: true, effect: 'no-op' };
  });
  let refused = false;
  try { await admitWorkspaceCapabilityWork({ ...workspaceProfile, providers: { codex: profile.required.map((capability, index) =>
    index === 0 ? { ...capability, tool: 'absent_tool' } : capability) } }, binding, adapter,
    () => { throw new Error('Unreachable work callback'); }); }
  catch (error) { if (error.code !== 'MISSING_CAPABILITY') throw error; refused = true; }
  const verifiedCapabilities = admitted.receipt.checks.map(check => check.capability);
  if (successfulProbeCalls !== 2 || JSON.stringify(verifiedCapabilities) !== JSON.stringify(workspaceProfile.required))
    throw new Error('Independent semantic probes were not established');
  assertActive();
  output = { ok: true, evidence: 'actual Codex app-server MCP discovery and two live calls to one pinned tool', executableSha256,
    receipt: admitted.receipt, admitted: admitted.result, missingRequiredToolRefused: refused,
    successfulProbeCalls, verifiedCapabilities,
    inferenceStarted: false, nativeWakeProven: false, fullAppParityProven: false };
} catch (error) {
  output = { ok: false, error: cancellationSignal ? 'trial_cancelled' : error.code ?? error.message, executableSha256, stderrBytes,
    inferenceStarted: false, nativeWakeProven: false, fullAppParityProven: false };
  process.exitCode = 2;
} finally {
  transportClosing = true;
  rejectAll();
  lines.close();
  // Track our detached process group, including descendants after its leader exits.
  // Never signal a discovered PID or a shared Codex daemon.
  let groupGone = false;
  const groupAlive = () => {
    if (!child.pid || groupGone) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if (error.code === 'ESRCH') groupGone = true; // Never follow a later reuse of this ID.
      return !groupGone;
    }
  };
  const signalOwnedGroup = signal => {
    if (!child.pid || !groupAlive()) return;
    try { process.kill(-child.pid, signal); } catch { /* verification below decides success */ }
  };
  const awaitStopped = async () => {
    const deadline = Date.now() + 2000;
    while ((!stopped || groupAlive()) && Date.now() < deadline) await delay(25);
  };
  signalOwnedGroup('SIGTERM');
  await awaitStopped();
  if (!stopped || groupAlive()) {
    signalOwnedGroup('SIGKILL');
    await awaitStopped();
  }
  output.childStopped = stopped;
  output.ownedGroupStopped = !groupAlive();
  output.runtimeStopped = stopped && output.ownedGroupStopped;
  output.cancelled = cancellationSignal !== null;
  output.cancellationSignal = cancellationSignal;
  if (cancellationSignal) {
    output.ok = false; output.error = 'trial_cancelled';
    process.exitCode = cancellationSignal === 'SIGINT' ? 130 : 143;
  }
  if (!output.runtimeStopped) { output.ok = false; output.error = 'owned_runtime_shutdown_unconfirmed'; process.exitCode = 2; }
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  writeFileSync(join(state, 'result.json'), JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ok: output.ok, result: join(state, 'result.json'), error: output.error ?? null,
    inferenceStarted: false, runtimeStopped: output.runtimeStopped, cancelled: output.cancelled,
    cancellationSignal: output.cancellationSignal }));
  process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm);
}
