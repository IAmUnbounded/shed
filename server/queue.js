import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Universal per-session follow-up queue & mid-run steering store.
// Lets you queue follow-ups while ANY harness is busy, reorder/promote them to steer immediately,
// and auto-dispatches the next queued message as soon as the session finishes its current turn.

const KEEP = 120;

export function queueStore(dataDir) {
  const file = path.join(dataDir, 'queue.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(list.slice(-KEEP), null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };

  return {
    all: () => list.filter(i => i.status === 'queued'),
    forSession: sessionId => list.filter(i => i.sessionId === sessionId && i.status === 'queued'),
    get: id => list.find(i => i.id === id) || null,
    enqueue({ sessionId, prompt, mode = 'build', model = '', followup = 'stay', attachments = [], skipPermissions = false }) {
      const clean = String(prompt || '').trim();
      if (!sessionId || !clean) throw new Error('Choose a session and write a message to queue.');
      if (clean.length > 20000) throw new Error('Queued prompt is too long.');
      const item = {
        id: `q-${crypto.randomBytes(6).toString('hex')}`,
        sessionId,
        prompt: clean,
        mode: mode === 'plan' ? 'plan' : 'build',
        model: String(model || ''),
        followup: String(followup || 'stay'),
        attachments: Array.isArray(attachments) ? attachments : [],
        skipPermissions: Boolean(skipPermissions),
        status: 'queued',
        createdAt: new Date().toISOString(),
      };
      list.push(item);
      if (list.length > KEEP) list = list.slice(-KEEP);
      save();
      return item;
    },
    cancel(id) {
      const item = list.find(i => i.id === id && i.status === 'queued');
      if (!item) return null;
      item.status = 'cancelled';
      item.updatedAt = new Date().toISOString();
      list = list.filter(i => i.status === 'queued');
      save();
      return item;
    },
    takeNext(sessionId) {
      const idx = list.findIndex(i => i.sessionId === sessionId && i.status === 'queued');
      if (idx < 0) return null;
      const [item] = list.splice(idx, 1);
      save();
      return item;
    },
    takeById(id) {
      const idx = list.findIndex(i => i.id === id && i.status === 'queued');
      if (idx < 0) return null;
      const [item] = list.splice(idx, 1);
      save();
      return item;
    },
    sessionsWithQueued() {
      return [...new Set(list.filter(i => i.status === 'queued').map(i => i.sessionId))];
    },
  };
}

export const queueSummary = item => ({
  id: item.id,
  sessionId: item.sessionId,
  prompt: item.prompt.slice(0, 400),
  mode: item.mode || 'build',
  model: item.model || '',
  createdAt: item.createdAt,
});

export function planModePrompt(prompt) {
  return [
    'PLAN MODE — DO NOT EDIT FILES OR RUN DESTRUCTIVE COMMANDS YET.',
    'Inspect the codebase and produce a concise, concrete implementation plan:',
    '1. Key findings / root cause.',
    '2. Exact files you plan to create or modify and what changes in each.',
    '3. Edge cases, risks, and how you will verify the change.',
    'Stop after presenting the plan and wait for approval to implement.',
    '',
    'Request:',
    String(prompt || '').trim(),
  ].join('\n');
}

export function steerPrompt(prompt) {
  return `Mid-run course correction from the user (adjust your current approach immediately):\n\n${String(prompt || '').trim()}`;
}
