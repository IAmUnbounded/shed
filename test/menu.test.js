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
      /Users/you/Shed Workspaces/my-app
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
    "2. Yes, and don't ask again for rm -rf build && npm run build commands in /Users/you/Shed Workspaces/my-app",
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

// Claude's AskUserQuestion with several choices allowed: a description under each option, a Submit row, a divider,
// then "Chat about this", and the hint 13 lines below the pointer.
const multi = `
────────────────────────────────────────────────────────────────────────────────
←  ☒ Route  ☒ Accounts  ✔ Submit  →

What do you already have set up?

❯ 1. [✔] Stripe or PayPal
         You can accept payments.
  2. [ ] Upwork, Fiverr or similar
         You have an active freelance profile.
  3. [✔] Social following or email list
         You have an audience to sell to.
  4. [ ] Nothing yet
         We start from scratch.
  5. [ ] Type something
     Submit
────────────────────────────────────────────────────────────────────────────────
  6. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;

test('reads a multiple-choice question with descriptions, its Submit row and the option below the divider', () => {
  const menu = parseMenu(multi);
  assert.equal(menu.current, 0);
  assert.deepEqual(menu.options, [
    '1. [✔] Stripe or PayPal You can accept payments.',
    '2. [ ] Upwork, Fiverr or similar You have an active freelance profile.',
    '3. [✔] Social following or email list You have an audience to sell to.',
    '4. [ ] Nothing yet We start from scratch.',
    '5. [ ] Type something',
    'Submit',
    '6. Chat about this',
  ]);
  assert.equal(keysToChoose(menu, 5), '\u001b[B'.repeat(5));
});

test('an answered question left on screen above the input box is not offered again', () => {
  assert.equal(parseMenu(`${multi}\n\n⏺ Thanks, starting now.\n\n────\n❯ \n────`), null);
});

test('reads the numbered list that ends the screen even without a hint line', () => {
  const review = `
Review your answers

 ● Which fruits?
   → Apple, Cherry

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`;
  assert.deepEqual(parseMenu(review), { options:['1. Submit answers', '2. Cancel'], current:0 });
  // The input box with typed text that happens to start with a number is not a question.
  assert.equal(parseMenu('⏺ Done.\n\n────\n❯ 1. do this next\n────\n  ⏵⏵ auto mode on'), null);
});
