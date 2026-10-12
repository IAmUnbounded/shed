// Reads the choice an agent is asking for from its terminal screen, so the phone can show the real options.
// Claude and Codex draw a list with a pointer (❯ or ›) on the highlighted option and a hint line under it, for example:
//
//    ❯ No, exit                                 ❯ 1. Yes
//      Yes, I trust this folder                   2. Yes, and don't ask again for this command
//                                                 3. No, and tell Claude what to do differently (esc)
//    Enter to confirm · Esc to cancel
//                                               Esc to cancel · Tab to amend
//
// Some lists are numbered and some are not, and a number plus Return does not choose on unnumbered ones (the Return
// picks the highlighted option instead). So Shed always chooses by moving the pointer with arrow keys, then Return.
const POINTER = /^(\s*)([❯›])\s+(\S.*)$/;
const HINT = /Enter to confirm|Esc to cancel|Press enter|to cancel|Tab to amend|enter to select|to navigate/i;
const RULE = /^\s*[─━]{3,}\s*$/;
// Questions with several options and a description under each put the hint far below the pointer.
const HINT_REACH = 30;

export function parseMenu(screen) {
  const lines = String(screen || '').replace(/\r/g, '').split('\n').map(line => line.replace(/\s+$/, '')).slice(-70);
  // The last pointer line with a hint below it (the input box's own ❯ has no hint, so it is skipped).
  let at = -1, hint = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) {
    if (!POINTER.test(lines[i])) continue;
    const below = lines.slice(i + 1, i + 1 + HINT_REACH).findIndex(line => HINT.test(line));
    if (below >= 0) { at = i; hint = i + 1 + below; }
    // Some questions have no hint (Claude's "Ready to submit your answers?"): a numbered list that ends the screen.
    else if (/^\d+\.\s/.test(lines[i].match(POINTER)[3]) && lines.slice(i + 1).every(line => !line.trim() || /^\s+(\d+\.\s|\s{3,}\S)/.test(line))
      && lines.slice(i + 1).some(line => /^\s+\d+\.\s/.test(line))) { at = i; hint = lines.length; }
  }
  if (at < 0) return null;
  // A pointer after the hint is the input box: the question was already answered.
  if (lines.slice(hint + 1).some(line => /^\s*[❯›](\s|$)/.test(line))) return null;
  const [, , , first] = lines[at].match(POINTER);
  const column = lines[at].length - first.length; // where the option text starts
  // An option line starts its text in the same column as the highlighted one; deeper lines continue the option above,
  // except a multi-choice question's own "Next" or "Submit" row.
  const textAt = line => line.length - line.trimStart().length;
  const isSubmit = line => /^(Submit|Next)$/.test(line.trim());
  const isOption = line => line.trim() && !HINT.test(line) && !RULE.test(line) && (POINTER.test(line) || isSubmit(line) || textAt(line) === column);
  const isContinuation = line => line.trim() && !HINT.test(line) && !RULE.test(line) && !POINTER.test(line) && !isSubmit(line) && textAt(line) > column;
  const label = line => (POINTER.test(line) ? line.match(POINTER)[3] : line.trim()).trim();
  let start = at;
  while (start > 0 && (isOption(lines[start - 1]) || isContinuation(lines[start - 1]))) start--;
  while (start < at && !isOption(lines[start])) start++;
  const options = [];
  let current = -1;
  for (let i = start; i < hint; i++) {
    const line = lines[i];
    if (isOption(line)) {
      if (i === at) current = options.length;
      options.push(label(line));
    } else if (isContinuation(line) && options.length) options[options.length - 1] += ` ${line.trim()}`;
    else if (!line.trim() || RULE.test(line)) continue; // a gap or a divider between options (for example "Chat about this")
    else break;
  }
  if (options.length < 2 || current < 0 || options.length > 12) return null;
  return { options, current };
}

// The keys that move the pointer from the highlighted option to `index`; the Return that follows makes the choice.
export function keysToChoose(menu, index) {
  const steps = index - menu.current;
  return (steps > 0 ? '\u001b[B' : '\u001b[A').repeat(Math.abs(steps));
}
