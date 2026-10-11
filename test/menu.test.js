import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMenu, keysToChoose } from '../server/menu.js';

const trust = `
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel`;

const claudeBash = `
 Bash command

   rm -rf build && npm run build
   Rebuild from scratch

 Do you want to proceed?
   1. Yes
 ❯ 2. Yes, and don't ask again for rm -rf build && npm run build commands in
      /Users/techie007/Shed Workspaces/my-app
   3. No, and tell Claude what to do differently (esc)

 Esc to cancel · Tab to amend · ctrl+e to explain`;

const codex = `
  Would you like to run the following command?

  $ npm test

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`;

const idle = `
⏺ Done. The build passes.

────────────────────────────────────────────────
❯ Try "how does <filepath> work?"
────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents`;

test('reads an unnumbered menu and which option is highlighted', () => {
  assert.deepEqual(parseMenu(trust), { options:['No, exit', 'Yes, I trust this folder'], current:0 });
});

test('reads numbered Claude options, joining a wrapped one, with the pointer on the second', () => {
  const menu = parseMenu(claudeBash);
  assert.equal(menu.current, 1);
  assert.deepEqual(menu.options, [
    '1. Yes',
    "2. Yes, and don't ask again for rm -rf build && npm run build commands in /Users/techie007/Shed Workspaces/my-app",
    '3. No, and tell Claude what to do differently (esc)',
  ]);
});

test('reads Codex approval options', () => {
  assert.deepEqual(parseMenu(codex), { options:['1. Yes, proceed (y)', "2. Yes, and don't ask again for this command (p)", '3. No, and tell Codex what to do differently (esc)'], current:0 });
});

test('the input box is not a menu', () => {
  assert.equal(parseMenu(idle), null);
  assert.equal(parseMenu(''), null);
});

test('choosing moves the pointer with arrow keys from where it is', () => {
  const menu = parseMenu(claudeBash);
  assert.equal(keysToChoose(menu, 1), '');
  assert.equal(keysToChoose(menu, 2), '\u001b[B');
  assert.equal(keysToChoose(menu, 0), '\u001b[A');
  assert.equal(keysToChoose(parseMenu(trust), 1), '\u001b[B');
});
