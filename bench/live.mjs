// Measures how fast the running Shed on this Mac answers, the way a phone uses it.
// Usage: node bench/live.mjs [base URL] [rounds]. Run on the Mac (it signs in with the local token).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || 'http://127.0.0.1:4378';
const rounds = Number(process.argv[3] || 20);
const token = process.env.LAYA_TOKEN || fs.readFileSync(path.join(root, '.laya-token'), 'utf8').trim();
const headers = { Authorization:`Bearer ${token}` };

async function time(url, init = {}) {
  const start = performance.now();
  const res = await fetch(base + url, { ...init, headers:{ ...headers, ...init.headers } });
  const body = await res.arrayBuffer();
  return { ms:performance.now() - start, status:res.status, bytes:body.byteLength, json:() => JSON.parse(Buffer.from(body).toString()) };
}
const pct = (list, p) => { const sorted = [...list].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))]; };
async function measure(name, url, init) {
  const times = []; let last;
  for (let i = 0; i < rounds; i++) { last = await time(url, init); times.push(last.ms); }
  return { name, p50:pct(times, 50), p95:pct(times, 95), max:Math.max(...times), bytes:last.bytes, status:last.status };
}

const { sessions, v } = (await time('/api/sessions')).json();
const live = sessions.find(s => s.tty && s.harness === 'claude') || sessions[0];
const sid = encodeURIComponent(live.id);
const rows = [];
rows.push(await measure('GET / (page)', '/'));
rows.push(await measure('GET /app.js', '/app.js'));
rows.push(await measure('GET /api/sessions', '/api/sessions'));
rows.push(await measure('GET /api/sessions?v= (unchanged)', `/api/sessions?v=${encodeURIComponent(v)}`));
rows.push(await measure('GET /api/tasks', '/api/tasks'));
rows.push(await measure('GET /api/sessions/:id (conversation)', `/api/sessions/${sid}`));
rows.push(await measure('GET /api/sessions/:id/files', `/api/sessions/${sid}/files`));
rows.push(await measure('GET /api/sessions/:id/terminal', `/api/sessions/${sid}/terminal`));
rows.push(await measure('GET /api/sessions/:id/changes', `/api/sessions/${sid}/changes`));
rows.push(await measure('GET /api/bootstrap', '/api/bootstrap'));
rows.push(await measure('GET /api/harness-health', '/api/harness-health'));
rows.push(await measure('POST /api/followup-preview', '/api/followup-preview', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ prompt:'add a test for the login form', sessionId:live.id }) }));

console.log(`${sessions.length} sessions · measured against ${live.id} · ${rounds} rounds each\n`);
console.log('endpoint'.padEnd(40), 'p50 ms'.padStart(8), 'p95 ms'.padStart(8), 'max ms'.padStart(8), 'KB'.padStart(8), ' status');
for (const r of rows) console.log(r.name.padEnd(40), r.p50.toFixed(1).padStart(8), r.p95.toFixed(1).padStart(8), r.max.toFixed(1).padStart(8), (r.bytes / 1024).toFixed(1).padStart(8), ` ${r.status}`);
