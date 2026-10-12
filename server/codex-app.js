import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Talks to the Codex app-server daemon that the Codex desktop app shares: JSON-RPC over a WebSocket on a Unix socket.
// Shed uses it to stop the turn a desktop-app Codex session is running (there is no process of its own to end).
export const CODEX_SOCKET = process.env.CODEX_APP_SOCKET || path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock');

function frame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, 0x80 | len])
    : len < 65536 ? Buffer.from([0x81, 0x80 | 126, len >> 8, len & 255])
    : Buffer.concat([Buffer.from([0x81, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, body]);
}
// Pulls complete frames off the buffer; returns the text messages and what is left over.
function unframe(buffer, partial) {
  const messages = [];
  for (;;) {
    if (buffer.length < 2) break;
    const fin = buffer[0] & 0x80, opcode = buffer[0] & 0x0f;
    let len = buffer[1] & 0x7f, offset = 2;
    if (len === 126) { if (buffer.length < 4) break; len = buffer.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (buffer.length < 10) break; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
    if (buffer.length < offset + len) break;
    const data = buffer.subarray(offset, offset + len);
    buffer = buffer.subarray(offset + len);
    if (opcode === 0x1 || opcode === 0x0) {
      partial.push(data);
      if (fin) { messages.push(Buffer.concat(partial).toString()); partial.length = 0; }
    }
  }
  return { messages, rest:buffer };
}

// What Shed answers when Codex asks this client something (an approval, a form, a question): always "no".
// Shed only asks while stopping a turn, and a turn waiting on an answer nobody gives cannot be interrupted.
export function refusal(method) {
  if (/elicitation/i.test(method)) return { result:{ action:'cancel' } };
  if (/^(execCommandApproval|applyPatchApproval)$/.test(method)) return { result:{ decision:'abort' } };
  if (/requestApproval/i.test(method)) return { result:{ decision:'cancel' } };
  return { error:{ code:-32601, message:'Shed does not answer this.' } };
}

// Opens a session, runs `work(call)` and closes. `call(method, params)` resolves with the result or throws the error.
export function withCodexApp(work, { socket = CODEX_SOCKET, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket);
    let handshake = true, buffer = Buffer.alloc(0), nextId = 0, settled = false;
    const partial = [], waiting = new Map();
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); conn.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('The Codex app did not answer.')), timeoutMs);
    const send = message => conn.write(frame(JSON.stringify({ jsonrpc:'2.0', ...message })));
    const call = (method, params = {}) => new Promise((ok, fail) => {
      const id = ++nextId;
      waiting.set(id, { ok, fail });
      send({ id, method, params });
    });
    conn.on('error', error => finish(new Error(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'The Codex app is not running.' : error.message)));
    conn.on('connect', () => conn.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    conn.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (handshake) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!/^HTTP\/1\.1 101/.test(buffer.subarray(0, end).toString())) return finish(new Error('The Codex app refused the connection.'));
        buffer = buffer.subarray(end + 4);
        handshake = false;
        call('initialize', { clientInfo:{ name:'shed', version:'0.2.0' }, capabilities:{ experimentalApi:true } })
          .then(() => { send({ method:'initialized' }); return work(call); })
          .then(value => finish(null, value), error => finish(error));
      }
      const { messages, rest } = unframe(buffer, partial);
      buffer = rest;
      for (const text of messages) {
        let message; try { message = JSON.parse(text); } catch { continue; }
        if (message.id != null && message.method) { send({ id:message.id, ...refusal(message.method) }); continue; }
        const pending = message.id != null && !message.method && waiting.get(message.id);
        if (!pending) continue;
        waiting.delete(message.id);
        message.error ? pending.fail(new Error(message.error.message || 'Codex refused the request.')) : pending.ok(message.result);
      }
    });
  });
}

const within = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(TIMED_OUT), ms))]);
const TIMED_OUT = Symbol('timed out');

// Stops the turn a Codex thread is running and the commands it started. `interrupted` is false when it was idle.
// Codex runs turns in a background daemon, so this works whether the session was started in the Codex app or in
// Terminal (where ending the codex process alone leaves its turn running in the daemon).
export function interruptCodexThread(threadId, { helpers = daemonHelpers, ...options } = {}) {
  return withCodexApp(async call => {
    const loaded = () => call('thread/loaded/list', {}).then(result => result?.data || []).catch(() => []);
    const open = (await loaded()).includes(threadId);
    // Attaching to an open thread makes the daemon resend any question the turn is waiting on; withCodexApp declines it.
    if (open) await call('thread/resume', { threadId, excludeTurns:true }).catch(() => {});
    const running = await runningTurn(call, threadId);
    let forced = false;
    if (running && await within(call('turn/interrupt', { threadId, turnId:running.id }), 5000) === TIMED_OUT) {
      // The turn is stuck inside a tool (for example a browser tool that never answers) and ignores the interrupt.
      // When it is the only thread the daemon has open, the helper processes the daemon started for this turn serve
      // nobody else, so they are stopped; the tool call then fails and the interrupt goes through.
      const now = await loaded();
      if (now.length !== 1 || now[0] !== threadId || !helpers.stop(running.startedAt)) throw new Error('Codex did not stop this turn. Stop it in the Codex app.');
      if (await within(call('turn/interrupt', { threadId, turnId:running.id }), 8000) === TIMED_OUT || await stillRunning(call, threadId)) throw new Error('Codex did not stop this turn. Stop it in the Codex app.');
      forced = true;
    }
    // An interrupted turn leaves the commands it started running in the daemon; they are stopped too.
    const commands = open ? await call('thread/backgroundTerminals/list', { threadId }).then(result => result?.data || []).catch(() => []) : [];
    if (commands.length) await call('thread/backgroundTerminals/clean', { threadId }).catch(() => {});
    return { interrupted:Boolean(running), turnId:running?.id, forced, commandsStopped:commands.length };
  }, { timeoutMs:30000, ...options });
}

async function stillRunning(call, threadId) {
  for (let i = 0; i < 10; i++) {
    if (!await runningTurn(call, threadId)) return false;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return true;
}

async function runningTurn(call, threadId) {
  // Recent turns, newest first; threads that cannot list turns (ephemeral ones) are read whole instead.
  const turns = await call('thread/turns/list', { threadId, limit:3, sortDirection:'desc' })
    .then(result => result?.data || [])
    .catch(() => call('thread/read', { threadId, includeTurns:true }).then(result => [...(result?.thread?.turns || [])].reverse()));
  return turns.find(turn => turn.status === 'inProgress') || null;
}

// The daemon's own helper processes (tool servers it starts for turns), found from the process list.
export const daemonHelpers = {
  stop(sinceSeconds) {
    const rows = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], { encoding:'utf8' }).stdout.split('\n')
      .map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.*)$/)).filter(Boolean)
      .map(([, pid, ppid, pgid, started, command]) => ({ pid:+pid, ppid:+ppid, pgid:+pgid, started:Date.parse(started) / 1000, command }));
    const daemon = rows.find(row => /\bcodex app-server\b.*--listen unix:\/\//.test(row.command));
    if (!daemon || !sinceSeconds) return false;
    // Started for this turn: children of the daemon that began within a few seconds of the turn or later.
    const helpers = rows.filter(row => row.ppid === daemon.pid && row.started >= sinceSeconds - 5);
    for (const row of helpers) { try { process.kill(row.pgid === row.pid ? -row.pid : row.pid, 'SIGTERM'); } catch { /* already gone */ } }
    return helpers.length > 0;
  },
};
