import fs from 'node:fs';
import path from 'node:path';

// Fan-out & Compare ("Race Agents") + Cross-Harness Review prompts.
// A comparison launches one prompt across 2–4 harnesses in parallel isolated git worktrees,
// tracks each contestant's task/session/diff, and lets the user pick a winner and clean up the rest.

const KEEP = 50;
const LABEL = { claude:'Claude Code', codex:'Codex', gemini:'Gemini', pi:'Pi', opencode:'OpenCode', antigravity:'Antigravity' };

export function compareStore(dataDir) {
  const file = path.join(dataDir, 'comparisons.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
  const save = () => {
    fs.mkdirSync(dataDir, { recursive:true, mode:0o700 });
    fs.writeFileSync(file, JSON.stringify(list.slice(0, KEEP), null, 2), { mode:0o600 });
    fs.chmodSync(file, 0o600);
  };
  return {
    all: () => list,
    get: id => list.find(c => c.id === id) || null,
    add(record) {
      list.unshift(record);
      if (list.length > KEEP) list = list.slice(0, KEEP);
      save();
      return record;
    },
    update(id, patch) {
      const record = list.find(c => c.id === id);
      if (!record) return null;
      Object.assign(record, patch, { updatedAt:new Date().toISOString() });
      save();
      return record;
    },
    // Syncs each contestant's status, sessionId, and output snippet from Shed's live tasks & sessions.
    sync(taskFor, sessionFor) {
      let changed = false;
      for (const comp of list) {
        let anyRunning = false;
        for (const entry of comp.entries || []) {
          const task = taskFor(entry.taskId);
          if (!task) continue;
          const session = task.sessionId ? sessionFor(task.sessionId) : null;
          const nextStatus = task.status || entry.status;
          const nextSession = task.sessionId || entry.sessionId || null;
          const nextOutput = String(task.output || '').trim().slice(-1200);
          const nextError = String(task.error || '').trim().slice(-400);
          const nextModel = task.model || entry.model || '';
          const nextLive = session?.liveState || (['running', 'queued'].includes(nextStatus) ? 'working' : 'history');
          if (entry.status !== nextStatus || entry.sessionId !== nextSession || entry.output !== nextOutput || entry.error !== nextError || entry.model !== nextModel || entry.liveState !== nextLive) {
            Object.assign(entry, { status:nextStatus, sessionId:nextSession, output:nextOutput, error:nextError, model:nextModel, liveState:nextLive });
            changed = true;
          }
          if (['running', 'queued', 'cancelling'].includes(entry.status)) anyRunning = true;
        }
        const nextOverall = comp.winnerTaskId ? 'decided' : anyRunning ? 'running' : 'ready';
        if (comp.status !== nextOverall) {
          comp.status = nextOverall;
          comp.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) save();
      return changed;
    },
  };
}

export function compareSummary(c) {
  return {
    id: c.id,
    title: c.title,
    prompt: c.prompt.slice(0, 400),
    project: c.project,
    status: c.status,
    winnerTaskId: c.winnerTaskId || null,
    winnerHarness: c.winnerHarness || null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    entries: (c.entries || []).map(e => ({
      harness: e.harness,
      model: e.model || '',
      taskId: e.taskId,
      sessionId: e.sessionId || null,
      cwd: e.cwd,
      branch: e.branch || '',
      status: e.status,
      liveState: e.liveState || 'history',
      output: (e.output || '').slice(-320),
      error: (e.error || '').slice(-200),
      cleaned: Boolean(e.cleaned),
    })),
  };
}

// Structured prompt for "Review with another harness": inspects uncommitted changes and branch commits,
// surfaces concrete bugs/edge cases/regressions, and optionally links back to the live author session via `shed ask`.
export function buildReviewPrompt({ authorSession, branch = '', files = [], focus = '', shedCli = '', canAskAuthor = false }) {
  const authorName = LABEL[authorSession.harness] || authorSession.harness;
  const fileList = files.slice(0, 40).map(f => `- ${f.status === '?' ? 'NEW' : f.status} ${f.path}${f.binary ? ' (binary)' : ` (+${f.additions} / -${f.deletions})`}`).join('\n');
  const lines = [
    `You are doing a focused code review of changes made by ${authorName} in this project${branch ? ` on branch \`${branch}\`` : ''}.`,
    authorSession.title ? `Original task: ${authorSession.title}` : '',
    focus ? `Specific review focus: ${focus.trim()}` : '',
    fileList ? `Changed files right now:\n${fileList}` : 'Run `git status` and `git diff` (and `git log -n 5 --stat` if commits were already made on this branch) to inspect the changes.',
    'Review instructions:',
    '1. Inspect the actual git diff and surrounding code carefully. Do NOT make edits unless explicitly asked — review first.',
    '2. Report concrete bugs, security issues, edge cases, missing tests, or regressions with exact `file:line` references, ranked by severity (Blocking / Important / Nit).',
    '3. End with a clear verdict: **Approve** or **Changes requested**, plus a short summary of what needs fixing.',
  ];
  if (canAskAuthor && shedCli) {
    lines.push(`The ${authorName} session is still open. If you need clarification or want it to apply specific fixes, you can message it directly with:\n${shedCli} ask ${authorSession.id} "your feedback"`);
  }
  return lines.filter(Boolean).join('\n\n');
}
