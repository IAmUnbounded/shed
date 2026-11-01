import test from 'node:test';
import assert from 'node:assert/strict';
import { autoRoutePrefs, routableHarnesses } from '../server/router.js';

const known = ['codex', 'claude', 'gemini', 'pi', 'opencode'];

test('a harness switched off is left out of what Laya can pick', () => {
  const prefs = autoRoutePrefs({ off:['codex'] }, known);
  assert.deepEqual(routableHarnesses(['codex', 'claude', 'gemini'], prefs), ['claude', 'gemini']);
});

test('nothing is switched off by default, and unknown or repeated names are dropped', () => {
  assert.deepEqual(autoRoutePrefs(undefined, known), { off:[] });
  assert.deepEqual(autoRoutePrefs({ off:['codex', 'codex', 'bogus', 7] }, known), { off:['codex'] });
  assert.deepEqual(autoRoutePrefs({ off:'codex' }, known), { off:[] });
});
