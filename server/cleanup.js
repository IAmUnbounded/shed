import fs from 'node:fs';

// Sessions that only clutter the list, and why: they never got an answer, were a quick test, live in a folder that is
// gone, or repeat another session word for word. Clearing one only hides it in Shed; the harness keeps its transcript.
// A live session, or one that answered in the last quarter hour, is never suggested.
const TEST_TITLE = /^(reply with just\b|this is a throwaway shed test|shed [\w ]{0,30}\btest\b)/i;
// Scratch folders (agents' scratchpads, quick experiments); per-user temp folders are left alone, as apps keep real work there.
const TEMP_DIRS = ['/tmp/', '/private/tmp/'];

export function cleanupSuggestions(sessions, { now = Date.now(), exists = dir => fs.existsSync(dir), tempDirs = TEMP_DIRS } = {}) {
  const reasons = new Map();
  const settled = s => s.liveState === 'history' && now - Date.parse(s.updatedAt) > 15 * 60 * 1000;
  for (const s of sessions) {
    if (!settled(s)) continue;
    if (s.cwd && tempDirs.some(dir => s.cwd.startsWith(dir))) reasons.set(s.id, 'test run');
    else if (TEST_TITLE.test(s.title)) reasons.set(s.id, 'test run');
    else if (s.replied === false) reasons.set(s.id, 'never answered');
    else if (s.cwd && !exists(s.cwd)) reasons.set(s.id, 'folder deleted');
  }
  // The same request sent again to the same harness and project (a retry, a double tap): keep the newest that answered.
  const groups = new Map();
  for (const s of sessions) {
    if (reasons.has(s.id) || s.title.length < 20 || s.title.startsWith('Untitled ')) continue;
    const key = `${s.harness}\n${s.title}\n${(s.cwd || '').replace(/-\d+$/, '')}`;
    groups.set(key, [...(groups.get(key) || []), s]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = [...group].sort((a, b) => (b.replied !== false) - (a.replied !== false) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    for (const s of group) if (s !== keep && settled(s)) reasons.set(s.id, 'duplicate');
  }
  return reasons;
}
