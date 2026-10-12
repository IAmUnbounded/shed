import test from 'node:test';
import assert from 'node:assert/strict';
import { claudePermissions, codexPermissions } from '../server/sessions.js';
import { footerMode } from '../server/live.js';

test("Claude's last recorded permission mode wins", () => {
  assert.equal(claudePermissions('{"permissionMode":"default"}\n{"permissionMode":"bypassPermissions"}'), 'skip');
  assert.equal(claudePermissions('{"permissionMode":"bypassPermissions"}\n{"permissionMode":"auto"}'), 'auto');
  assert.equal(claudePermissions('{"permissionMode":"acceptEdits"}'), 'edits');
  assert.equal(claudePermissions('{"type":"user"}'), '');
});

test('Codex skips permissions only with no approvals and full access', () => {
  assert.equal(codexPermissions('{"approval_policy":"never","sandbox_policy":{"type":"danger-full-access"}}'), 'skip');
  assert.equal(codexPermissions('{"approval_policy":"on-request","sandbox_policy":{"type":"workspace-write"}}'), 'ask');
  assert.equal(codexPermissions('{"approval_policy":"never","sandbox_policy":{"type":"workspace-write"}}'), 'ask');
  assert.equal(codexPermissions('{"model":"x"}'), '');
});

test("Claude's footer gives the live mode; a question hiding it gives nothing", () => {
  const box = footer => `⏺ Done.\n────────────────────\n❯ \n────────────────────\n  ${footer}`;
  assert.equal(footerMode(box('⏵⏵ bypass permissions on (shift+tab to cycle)')), 'skip');
  assert.equal(footerMode(box('⏵⏵ auto mode on (shift+tab to cycle) · ← for agents')), 'auto');
  assert.equal(footerMode(box('⏸ plan mode on (shift+tab to cycle)')), 'plan');
  assert.equal(footerMode(box('? for shortcuts')), 'ask');
  assert.equal(footerMode('Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel'), '');
});
