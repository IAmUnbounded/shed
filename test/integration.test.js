import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitFor(url) {
  for (let i = 0; i < 80; i++) {
    try { const response = await fetch(url); if (response.status === 401) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Fixture server did not start.');
}

test('discovers a desktop session and resumes it through the task API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-integration-'));
  const home = path.join(dir, 'home'), bin = path.join(dir, 'bin'), project = path.join(dir, 'project');
  fs.mkdirSync(path.join(home, '.codex', 'sessions', '2026', '09', '23'), { recursive: true });
  fs.mkdirSync(bin); fs.mkdirSync(project);
  const sessionId = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(home, '.codex', 'sessions', '2026', '09', '23', `rollout-${sessionId}.jsonl`), [
    JSON.stringify({ type:'session_meta', payload:{ id:sessionId, cwd:project } }),
    JSON.stringify({ type:'response_item', payload:{ type:'message', role:'user', content:[{type:'input_text', text:'Build the lunar dashboard'}] } }),
  ].join('\n') + '\n');
  const piDir = path.join(home, '.pi', 'agent', 'sessions', '--tmp-project--');
  fs.mkdirSync(piDir, { recursive:true });
  fs.writeFileSync(path.join(piDir, 'session.jsonl'), [
    JSON.stringify({ type:'session', id:'pi-fixture', cwd:project }),
    JSON.stringify({ type:'message', message:{ role:'user', content:[{type:'text', text:'Review the lunar dashboard'}] } }),
  ].join('\n') + '\n');
  const fake = path.join(bin, 'codex');
  fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'codex-cli fixture'; exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo 'Logged in using fixture'; exit 0; fi\nif [ "$1" = "queue" ]; then printf '%s\\n' "$@" > "$JEV_FAKE_QUEUE_ARGS"; echo 'Queued message fixture for thread ${sessionId}.'; exit 0; fi\nif [ "$1" = "exec" ] && [ "$2" = "resume" ] && [ -f "$JEV_FAKE_CONFLICT" ]; then echo 'thread-store conflict: thread ${sessionId} already has an active writer' >&2; exit 1; fi\nprintf '%s\\n' "$@" > "$JEV_FAKE_ARGS"\necho '{"type":"thread.started","thread_id":"${sessionId}"}'\ncat > "$JEV_FAKE_ARGS.stdin"\necho '{"type":"item.completed","item":{"type":"agent_message","text":"fixture complete"}}'\n`);
  fs.chmodSync(fake, 0o755);
  const opencode = path.join(bin, 'opencode');
  fs.writeFileSync(opencode, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'fixture'; exit 0; fi\nif [ "$1" = "auth" ]; then echo '0 credentials'; exit 0; fi\nif [ "$1" = "session" ]; then echo '[{"id":"oc-fixture","title":"OpenCode research","directory":"${project}","time":{"updated":1780000000000}}]'; elif [ "$1" = "export" ]; then echo '{"messages":[]}'; fi\n`);
  fs.chmodSync(opencode, 0o755);
  const port = await freePort(), token = 'integration-secret';
  const child = spawn(process.execPath, ['server/index.js'], { cwd:path.resolve('.'), env:{ ...process.env, HOME:home, PATH:`${bin}:/usr/bin:/bin`, LAYA_DATA_DIR:path.join(dir, 'data'), JEV_FAKE_ARGS:path.join(dir, 'args'), JEV_FAKE_QUEUE_ARGS:path.join(dir, 'queue-args'), JEV_FAKE_CONFLICT:path.join(dir, 'conflict'), LAYA_TOKEN:token, LAYA_PRELOAD:'0', LAYA_HEADLESS_CLAUDE:'1', LAYA_HEADLESS_CODEX:'1', SHED_LAN:'1', HOST:'127.0.0.1', PORT:String(port) }, stdio:'ignore' });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/api/me`);
    const setup = await fetch(`${base}/api/password/setup`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ password:'fixture-password' }) });
    assert.equal(setup.status, 200);
    const login = await fetch(`${base}/api/auth`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ password:'fixture-password' }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie') || '', /shed_session=[\w-]{30,}; HttpOnly; SameSite=Strict/);
    assert.equal(login.headers.get('x-frame-options'), 'DENY');
    assert.match(login.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

    const headers = { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' };
    // Through the tunnel (Cloudflare adds these headers), a password alone is not enough: the device waits for the Mac.
    const viaTunnel = (ip, extra = {}) => ({ 'Content-Type':'application/json', 'x-forwarded-proto':'https', 'cf-connecting-ip':ip, ...extra });
    const cookieOf = response => (response.headers.get('set-cookie') || '').match(/shed_session=([^;]+)/)?.[1];
    const remote = await fetch(`${base}/api/auth`, { method:'POST', headers:viaTunnel('203.0.113.7'), body:JSON.stringify({ password:'fixture-password' }) });
    assert.equal(remote.status, 202);
    assert.match(remote.headers.get('set-cookie') || '', /Secure/);
    const pendingCookie = cookieOf(remote);
    assert.equal((await fetch(`${base}/api/sessions`, { headers:viaTunnel('203.0.113.7', { cookie:`shed_session=${pendingCookie}` }) })).status, 401, 'a pending device cannot see sessions');
    assert.equal((await fetch(`${base}/api/tasks`, { method:'POST', headers:viaTunnel('203.0.113.7', { cookie:`shed_session=${pendingCookie}` }), body:JSON.stringify({ prompt:'hi' }) })).status, 401, 'a pending device cannot send messages');
    assert.equal((await fetch(`${base}/api/sessions`, { headers:viaTunnel('203.0.113.8', { Authorization:`Bearer ${token}` }) })).status, 401, 'the master token is refused through the tunnel');
    const deviceList = (await (await fetch(`${base}/api/devices`, { headers })).json()).devices;
    const pendingDevice = deviceList.find(d => d.status === 'pending');
    assert.ok(pendingDevice);
    assert.equal((await fetch(`${base}/api/devices/${pendingDevice.id}/approve`, { method:'POST', headers:viaTunnel('203.0.113.7', { cookie:`shed_session=${pendingCookie}` }) })).status, 401);
    assert.equal((await fetch(`${base}/api/devices/${pendingDevice.id}/approve`, { method:'POST', headers })).status, 200, 'the Mac approves it');
    assert.equal((await fetch(`${base}/api/sessions`, { headers:viaTunnel('203.0.113.7', { cookie:`shed_session=${pendingCookie}` }) })).status, 200, 'approved devices get in');
    // An approved phone still cannot approve more devices; only the Mac can.
    const third = await fetch(`${base}/api/auth`, { method:'POST', headers:viaTunnel('198.51.100.4'), body:JSON.stringify({ password:'fixture-password' }) });
    const thirdId = (await third.json()).device.id;
    assert.equal((await fetch(`${base}/api/devices/${thirdId}/approve`, { method:'POST', headers:viaTunnel('203.0.113.7', { cookie:`shed_session=${pendingCookie}` }) })).status, 403);

    // The QR code's one-time pairing code approves a device straight away, once.
    const connect = await (await fetch(`${base}/api/connect`, { headers })).json();
    const pairCode = (connect.url.match(/#pair=([\w-]+)/) || [])[1];
    assert.ok(pairCode, 'the QR link carries a pairing code when opened on the Mac');
    const paired = await fetch(`${base}/api/auth`, { method:'POST', headers:viaTunnel('192.0.2.9'), body:JSON.stringify({ password:'fixture-password', pairCode }) });
    assert.equal(paired.status, 200);
    const reused = await fetch(`${base}/api/auth`, { method:'POST', headers:viaTunnel('192.0.2.10'), body:JSON.stringify({ password:'fixture-password', pairCode }) });
    assert.equal(reused.status, 202, 'a pairing code works once');

    // Wrong passwords are limited per visitor, so a stranger cannot lock out someone else.
    for (let i = 0; i < 8; i++) await fetch(`${base}/api/auth`, { method:'POST', headers:viaTunnel('203.0.113.66'), body:JSON.stringify({ password:'wrong' }) });
    assert.equal((await fetch(`${base}/api/auth`, { method:'POST', headers:viaTunnel('203.0.113.66'), body:JSON.stringify({ password:'wrong' }) })).status, 429);
    assert.equal((await fetch(`${base}/api/auth`, { method:'POST', headers:viaTunnel('203.0.113.67'), body:JSON.stringify({ password:'fixture-password' }) })).status, 202);

    // Signing out revokes that device's key on the server.
    const phoneCookie = { cookie:`shed_session=${pendingCookie}` };
    await fetch(`${base}/api/logout`, { method:'POST', headers:viaTunnel('203.0.113.7', phoneCookie) });
    assert.equal((await fetch(`${base}/api/sessions`, { headers:viaTunnel('203.0.113.7', phoneCookie) })).status, 401, 'a signed-out key stops working');
    const health = await (await fetch(`${base}/api/harness-health`, { headers })).json();
    assert.equal(health.harnesses.codex.state, 'ready');
    // Files an agent made: listed and served from inside the project only
    fs.mkdirSync(path.join(project, 'out'), { recursive:true });
    fs.writeFileSync(path.join(project, 'out', 'demo.mp4'), Buffer.from('0123456789'));
    fs.writeFileSync(path.join(dir, 'outside.png'), 'secret');
    fs.symlinkSync(path.join(dir, 'outside.png'), path.join(project, 'out', 'link.png'));
    const fileList = await (await fetch(`${base}/api/sessions/${encodeURIComponent(`codex:${sessionId}`)}/files`, { headers })).json();
    assert.ok(fileList.files.some(f => f.path === path.join('out', 'demo.mp4') && f.kind === 'video'));
    const fileBase = `${base}/api/sessions/${encodeURIComponent(`codex:${sessionId}`)}/file?path=`;
    const ranged = await fetch(`${fileBase}${encodeURIComponent('out/demo.mp4')}`, { headers:{ ...headers, Range:'bytes=2-5' } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), '2345');
    for (const escape of ['../outside.png', path.join(dir, 'outside.png'), 'out/link.png', '../../../../etc/hosts']) {
      assert.equal((await fetch(`${fileBase}${encodeURIComponent(escape)}`, { headers })).status, 404, `refuses ${escape}`);
    }
    const pushInfo = await (await fetch(`${base}/api/push`, { headers })).json();
    assert.match(pushInfo.publicKey, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal((await fetch(`${base}/api/push/subscribe`, { method:'POST', headers, body:JSON.stringify({ subscription:{ endpoint:'http://evil.test' } }) })).ok, false);
    const connectInfo = await (await fetch(`${base}/api/connect`, { headers })).json();
    assert.match(connectInfo.link, /^http:\/\/.+:\d+$/, 'without a tunnel, the phone link is the Wi-Fi address');
    assert.match(connectInfo.qr, /^<svg/);
    assert.equal(health.harnesses.opencode.state, 'needs_auth');
    const list = await (await fetch(`${base}/api/sessions`, { headers })).json();
    assert.equal(list.sessions.length, 3);
    assert.ok(list.sessions.some(s => s.id === `codex:${sessionId}`));
    assert.ok(list.sessions.some(s => s.id === 'pi:pi-fixture'));
    assert.ok(list.sessions.some(s => s.id === 'opencode:oc-fixture'));
    const preview = await (await fetch(`${base}/api/route`, { method:'POST', headers, body:JSON.stringify({ prompt:'Please improve the lunar dashboard', sessionId:`codex:${sessionId}` }) })).json();
    assert.equal(preview.route.session.id, `codex:${sessionId}`);
    const savedModels = await fetch(`${base}/api/models`, { method:'POST', headers, body:JSON.stringify({ harness:'codex', models:[{id:'fixture-fast',label:'Fast',description:'Quick work',enabled:true},{id:'fixture-deep',label:'Deep',description:'Hard work',enabled:true}], defaultModel:'fixture-fast' }) });
    assert.equal(savedModels.status, 200);
    const modelStatus = await (await fetch(`${base}/api/settings`, { headers })).json();
    assert.equal(modelStatus.local, true);
    const response = await fetch(`${base}/api/tasks`, { method:'POST', headers, body:JSON.stringify({ prompt:'Please improve the lunar dashboard', sessionId:`codex:${sessionId}`, model:'fixture-deep' }) });
    assert.equal(response.status, 201);
    const created = (await response.json()).task;
    let task;
    for (let i = 0; i < 60; i++) {
      task = (await (await fetch(`${base}/api/tasks/${created.id}`, { headers })).json()).task;
      if (task.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(task.status, 'completed');
    assert.match(task.output, /fixture complete/);
    assert.equal(task.sessionId, `codex:${sessionId}`);
    assert.equal(task.model, 'fixture-deep');
    assert.equal(task.modelSource, 'selected');
    assert.match(fs.readFileSync(path.join(dir, 'args'), 'utf8'), /--model\nfixture-deep/);
    // A resumed session now uses model routing too. One enabled model keeps this
    // integration test deterministic and avoids loading the production Laya model.
    assert.equal((await fetch(`${base}/api/models`, { method:'POST', headers, body:JSON.stringify({ harness:'codex', models:[{id:'fixture-fast',label:'Fast',enabled:true}], defaultModel:'fixture-fast' }) })).status, 200);
    const sameSessionPreview = (await (await fetch(`${base}/api/followup-preview`, { method:'POST', headers, body:JSON.stringify({ prompt:'Keep improving the lunar dashboard', sessionId:`codex:${sessionId}` }) })).json()).route;
    assert.equal(sameSessionPreview.harness, 'codex');
    assert.equal(sameSessionPreview.handoff, false);
    assert.equal(sameSessionPreview.model, 'fixture-fast');
    fs.writeFileSync(path.join(dir, 'conflict'), '1');
    const queuedPrompt = 'Continue the lunar dashboard from my phone';
    const queuedResponse = await fetch(`${base}/api/tasks`, { method:'POST', headers, body:JSON.stringify({ prompt:queuedPrompt, sessionId:`codex:${sessionId}` }) });
    assert.equal(queuedResponse.status, 201);
    const queuedId = (await queuedResponse.json()).task.id;
    let queuedTask;
    for (let i = 0; i < 60; i++) {
      queuedTask = (await (await fetch(`${base}/api/tasks/${queuedId}`, { headers })).json()).task;
      if (queuedTask.status === 'queued' && fs.existsSync(path.join(dir, 'queue-args'))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(queuedTask.status, 'queued');
    assert.equal(queuedTask.delivery, 'queue');
    assert.match(fs.readFileSync(path.join(dir, 'queue-args'), 'utf8'), new RegExp(`queue\\n--thread\\n${sessionId}\\n--message\\n${queuedPrompt}`));
    const transcript = path.join(home, '.codex', 'sessions', '2026', '09', '23', `rollout-${sessionId}.jsonl`);
    fs.appendFileSync(transcript, [
      JSON.stringify({ timestamp:new Date().toISOString(), type:'response_item', payload:{ type:'message', role:'user', content:[{ type:'input_text', text:queuedPrompt }] } }),
      JSON.stringify({ timestamp:new Date().toISOString(), type:'event_msg', payload:{ type:'task_started' } }),
      JSON.stringify({ timestamp:new Date().toISOString(), type:'response_item', payload:{ type:'message', role:'assistant', content:[{ type:'output_text', text:'Queued follow-up complete' }] } }),
      JSON.stringify({ timestamp:new Date().toISOString(), type:'event_msg', payload:{ type:'task_complete' } }),
    ].join('\n') + '\n');
    queuedTask = (await (await fetch(`${base}/api/tasks/${queuedId}`, { headers })).json()).task;
    assert.equal(queuedTask.status, 'completed');
    assert.match(queuedTask.output, /Queued follow-up complete/);
    const tasksBeforePreview = (await fetch(`${base}/api/tasks`, { headers }).then(r => r.json())).tasks.length;
    // Both preview and send must fail in place when Pi is unavailable.
    for (const endpoint of ['/api/followup-preview', '/api/tasks']) {
      const refused = await fetch(`${base}${endpoint}`, { method:'POST', headers, body:JSON.stringify({ prompt:'Add charts to the lunar dashboard', sessionId:'pi:pi-fixture' }) });
      assert.equal(refused.status, 400);
      assert.match((await refused.json()).error, /This session stays on pi/);
    }
    assert.equal((await fetch(`${base}/api/tasks`, { headers }).then(r => r.json())).tasks.length, tasksBeforePreview, 'an unavailable harness must not create a task elsewhere');
    const followupPreview = (await (await fetch(`${base}/api/followup-preview`, { method:'POST', headers, body:JSON.stringify({ prompt:'Add charts to the lunar dashboard', sessionId:'pi:pi-fixture', followup:'codex' }) })).json()).route;
    assert.equal(followupPreview.harness, 'codex');
    assert.equal(followupPreview.handoff, true);
    assert.equal((await fetch(`${base}/api/tasks`, { headers }).then(r => r.json())).tasks.length, tasksBeforePreview, 'a preview must not start a task');
    const handoffResponse = await fetch(`${base}/api/tasks`, { method:'POST', headers, body:JSON.stringify({ prompt:'Add charts to the lunar dashboard', sessionId:'pi:pi-fixture', followup:'codex' }) });
    assert.equal(handoffResponse.status, 201);
    const handoff = (await handoffResponse.json()).task;
    assert.equal(handoff.harness, 'codex');
    assert.equal(handoff.handoffFrom, 'pi:pi-fixture');
    assert.equal(handoff.cwd, project);
    assert.equal(handoff.prompt, 'Add charts to the lunar dashboard');
    let handoffTask;
    for (let i = 0; i < 60; i++) {
      handoffTask = (await (await fetch(`${base}/api/tasks/${handoff.id}`, { headers })).json()).task;
      if (handoffTask.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(handoffTask.status, 'completed');
    const handoffInput = fs.readFileSync(path.join(dir, 'args.stdin'), 'utf8');
    assert.match(handoffInput, /complete earlier transcript[\s\S]*session\.jsonl/, 'a handoff points the new agent at the full original transcript');
    assert.match(handoffInput, /continuing work that began in a pi session/);
    assert.match(handoffInput, /\[user\] Review the lunar dashboard/);
    assert.match(handoffInput, /New request:\nAdd charts to the lunar dashboard/);
    const stayResponse = await fetch(`${base}/api/tasks`, { method:'POST', headers, body:JSON.stringify({ prompt:'Keep reviewing', sessionId:'pi:pi-fixture', followup:'stay' }) });
    assert.equal(stayResponse.status, 400);
    const freshResponse = await fetch(`${base}/api/tasks`, { method:'POST', headers, body:JSON.stringify({ prompt:'Create a fresh phone-started project', harness:'codex', model:'fixture-fast', newSession:true, newWorkspace:'phone-project' }) });
    assert.equal(freshResponse.status, 201);
    const fresh = (await freshResponse.json()).task;
    let freshTask;
    for (let i = 0; i < 60; i++) {
      freshTask = (await (await fetch(`${base}/api/tasks/${fresh.id}`, { headers })).json()).task;
      if (freshTask.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(freshTask.status, 'completed');
    assert.equal(freshTask.cwd, path.join(home, 'Shed Workspaces', 'phone-project'));
    assert.equal(fs.existsSync(freshTask.cwd), true);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive:true, force:true });
  }
});
