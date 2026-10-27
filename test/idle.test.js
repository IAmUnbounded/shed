import test from 'node:test';
import assert from 'node:assert/strict';
import { idleSessions, autoClosePrefs } from '../server/idle.js';

const now = Date.parse('2026-10-24T12:00:00Z');
const hoursAgo = h => new Date(now - h * 3600000).toISOString();
const session = (id, patch) => ({ id, tty:'/dev/ttys001', liveState:'idle', updatedAt:hoursAgo(13), ...patch });

test('picks live Terminal sessions with no activity for 12 hours', () => {
  const list = [
    session('stale'),
    session('fresh', { updatedAt:hoursAgo(2) }),
    session('working', { liveState:'working' }),
    session('closed', { liveState:'history' }),
    session('desktop-app', { tty:'' }),
    session('asking', { liveState:'asking' }),
  ];
  assert.deepEqual(idleSessions(list, { now }).map(s => s.id), ['stale', 'asking']);
});

test('a recent Shed message or status change counts as activity', () => {
  const list = [session('messaged'), session('status'), session('pending')];
  const tasks = [
    { sessionId:'messaged', status:'completed', createdAt:hoursAgo(3), updatedAt:hoursAgo(3) },
    { sessionId:'pending', status:'running', createdAt:hoursAgo(20), updatedAt:hoursAgo(20) },
  ];
  const statusOf = s => s.id === 'status' ? now - 3600000 : 0;
  assert.deepEqual(idleSessions(list, { now, tasks, statusOf }), []);
});

test('prefs default to on at 12 hours and reject odd values', () => {
  assert.deepEqual(autoClosePrefs(), { enabled:true, hours:12 });
  assert.deepEqual(autoClosePrefs({ enabled:false, hours:0 }), { enabled:false, hours:12 });
  assert.deepEqual(autoClosePrefs({ hours:24 }), { enabled:true, hours:24 });
});
