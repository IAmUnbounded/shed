// Auto-close: live sessions in a Terminal tab with no activity for a while are ended, and their tab is closed.
// Activity is the latest of: the transcript being written, the agent's own status change, and any Shed message to it.
// A session that is working right now is never touched, however old its transcript looks.
export const DEFAULT_IDLE_HOURS = 12;

export function autoClosePrefs(saved = {}) {
  const hours = Number(saved.hours);
  return { enabled:saved.enabled !== false, hours:Number.isFinite(hours) && hours >= 1 && hours <= 24 * 30 ? hours : DEFAULT_IDLE_HOURS };
}

export function lastActivity(session, { tasks = [], statusUpdatedAt = 0 } = {}) {
  const times = [Date.parse(session.updatedAt) || 0, Number(statusUpdatedAt) || 0];
  for (const task of tasks) if (task.sessionId === session.id) times.push(Date.parse(task.updatedAt) || 0, Date.parse(task.createdAt) || 0);
  return Math.max(...times);
}

export function idleSessions(list, { now = Date.now(), hours = DEFAULT_IDLE_HOURS, tasks = [], statusOf = () => 0 } = {}) {
  const limit = hours * 3600000;
  const busy = new Set(tasks.filter(t => ['running', 'queued', 'cancelling'].includes(t.status)).map(t => t.sessionId));
  return list.filter(session => session.tty && session.liveState !== 'history' && session.liveState !== 'working' && !busy.has(session.id)
    && now - lastActivity(session, { tasks, statusUpdatedAt:statusOf(session) }) > limit);
}
