import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { interruptCodexThread, refusal } from '../server/codex-app.js';

// A stand-in for the Codex daemon: a WebSocket JSON-RPC server on a Unix socket. `handle(message, reply, push)` answers.
function fakeDaemon(handle) {
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shed-cx-')), 'd.sock');
  const seen = [];
  const server = net.createServer(conn => {
    let buffer = Buffer.alloc(0), upgraded = false;
    const push = message => {
      const body = Buffer.from(JSON.stringify(message));
      const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
      conn.write(Buffer.concat([head, body]));
    };
    conn.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        buffer = buffer.subarray(end + 4); upgraded = true;
        conn.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      }
      while (buffer.length >= 6) {
        let len = buffer[1] & 0x7f, offset = 2;
        if (len === 126) { len = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + len) break;
        const mask = buffer.subarray(offset, offset + 4), data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + len);
        const message = JSON.parse(data.toString());
        seen.push(message);
        if (message.method === 'initialize') push({ id:message.id, result:{} });
        else handle(message, result => push({ id:message.id, result }), push);
      }
    });
  });
  return new Promise(resolve => server.listen(socket, () => resolve({ socket, seen, close:() => server.close() })));
}

test('Shed declines whatever Codex asks while it stops a turn', () => {
  assert.deepEqual(refusal('mcpServer/elicitation/request'), { result:{ action:'cancel' } });
  assert.deepEqual(refusal('item/commandExecution/requestApproval'), { result:{ decision:'cancel' } });
  assert.deepEqual(refusal('execCommandApproval'), { result:{ decision:'abort' } });
  assert.ok(refusal('item/tool/requestUserInput').error);
});

test('a turn waiting on an approval is declined, interrupted, and its leftover commands stopped', async () => {
  let status = 'inProgress', approved = null, cleaned = false;
  const daemon = await fakeDaemon((m, reply, push) => {
    if (!m.method && m.id === 0) approved = m.result;
    if (m.method === 'thread/loaded/list') reply({ data:['t1'] });
    if (m.method === 'thread/resume') { reply({}); push({ id:0, method:'mcpServer/elicitation/request', params:{ threadId:'t1' } }); }
    if (m.method === 'thread/turns/list') reply({ data:[{ id:'turn1', status, startedAt:1 }] });
    // Like the real daemon, the interrupt only answers once nothing is waiting on an approval.
    if (m.method === 'turn/interrupt' && approved) { status = 'interrupted'; reply({}); }
    if (m.method === 'thread/backgroundTerminals/list') reply({ data:cleaned ? [] : [{ processId:'7', command:'sleep 300' }] });
    if (m.method === 'thread/backgroundTerminals/clean') { cleaned = true; reply({}); }
  });
  try {
    const result = await interruptCodexThread('t1', { socket:daemon.socket });
    assert.deepEqual(approved, { action:'cancel' });
    assert.equal(result.interrupted, true);
    assert.equal(result.commandsStopped, 1);
    assert.ok(cleaned);
  } finally { daemon.close(); }
});

test('a turn stuck inside a tool is unstuck by stopping the helpers the daemon started for it', async () => {
  let status = 'inProgress', helpersStopped = false;
  const daemon = await fakeDaemon((m, reply) => {
    if (m.method === 'thread/loaded/list') reply({ data:['t1'] });
    if (m.method === 'thread/resume') reply({});
    if (m.method === 'thread/turns/list') reply({ data:[{ id:'turn1', status, startedAt:1700000000 }] });
    if (m.method === 'turn/interrupt' && helpersStopped) { status = 'interrupted'; reply({}); }
    if (m.method === 'thread/backgroundTerminals/list') reply({ data:[] });
  });
  try {
    const helpers = { stop:since => { assert.equal(since, 1700000000); helpersStopped = true; return true; } };
    const result = await interruptCodexThread('t1', { socket:daemon.socket, helpers });
    assert.equal(result.forced, true);
    assert.equal(status, 'interrupted');
  } finally { daemon.close(); }
});

test('helpers are never stopped while the daemon has other threads open', async () => {
  const daemon = await fakeDaemon((m, reply) => {
    if (m.method === 'thread/loaded/list') reply({ data:['t1', 'someone-else'] });
    if (m.method === 'thread/resume') reply({});
    if (m.method === 'thread/turns/list') reply({ data:[{ id:'turn1', status:'inProgress', startedAt:1 }] });
  });
  try {
    const helpers = { stop:() => assert.fail('helpers must not be stopped') };
    await assert.rejects(interruptCodexThread('t1', { socket:daemon.socket, helpers }), /did not stop/);
  } finally { daemon.close(); }
});
