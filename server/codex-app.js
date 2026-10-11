import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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
        call('initialize', { clientInfo:{ name:'shed', version:'0.2.0' } })
          .then(() => { send({ method:'initialized' }); return work(call); })
          .then(value => finish(null, value), error => finish(error));
      }
      const { messages, rest } = unframe(buffer, partial);
      buffer = rest;
      for (const text of messages) {
        let message; try { message = JSON.parse(text); } catch { continue; }
        const pending = message.id != null && !message.method && waiting.get(message.id);
        if (!pending) continue;
        waiting.delete(message.id);
        message.error ? pending.fail(new Error(message.error.message || 'Codex refused the request.')) : pending.ok(message.result);
      }
    });
  });
}

// Stops the turn a Codex thread is running. Returns { interrupted:true } or { interrupted:false } when it was idle.
export function interruptCodexThread(threadId, options) {
  return withCodexApp(async call => {
    // Recent turns, newest first; threads that cannot list turns (ephemeral ones) are read whole instead.
    const turns = await call('thread/turns/list', { threadId, limit:3, sortDirection:'desc' })
      .then(result => result?.data || [])
      .catch(() => call('thread/read', { threadId, includeTurns:true }).then(result => [...(result?.thread?.turns || [])].reverse()));
    const running = turns.find(turn => turn.status === 'inProgress');
    if (!running) return { interrupted:false };
    await call('turn/interrupt', { threadId, turnId:running.id });
    return { interrupted:true, turnId:running.id };
  }, options);
}
