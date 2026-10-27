import fs from 'node:fs';
import path from 'node:path';

// Exchanges: one agent session asking another a question through Shed. The question is delivered to the other
// session as a Shed task (typed into its Terminal like any follow-up), and that task's reply is the answer.
export const MAX_DEPTH = 3;
export const HOURLY_LIMIT = 20;
const KEEP = 200;
const label = { claude:'Claude', codex:'Codex', gemini:'Gemini', pi:'Pi', opencode:'OpenCode' };
const project = cwd => cwd ? path.basename(cwd) : 'a project';
export const describe = session => `${label[session.harness] || session.harness} session working on ${project(session.cwd)} ("${String(session.title || '').slice(0, 80)}")`;

// The first line marks the message for the UI, which shows it as coming from the other agent rather than from you.
export const MESSAGE_MARK = 'Message from another agent session, sent through Shed';
export function messagePrompt(from, message, cli) {
  return [
    `${MESSAGE_MARK}. It is the ${describe(from)}:`,
    message.trim(),
    `Answer in your normal reply; Shed passes your reply back to it. If you need to ask it something yourself, run: ${cli} ask ${from.id} "your message"`,
  ].join('\n\n');
}
export function introductionPrompt(to, note, cli) {
  return [
    note.trim() || `Work with the ${describe(to)}.`,
    `You can talk to the ${describe(to)}. To send it a message and wait for its reply, run:\n${cli} ask ${to.id} "your message"`,
    `The reply is printed when it answers. If it is still working when the command returns, run ${cli} reply <exchange id> to keep waiting. Run ${cli} sessions to see the other open sessions.`,
  ].join('\n\n');
}

// Why an exchange may not start, or '' when it may. `open` are exchanges still waiting on a reply.
export function refusal({ from, to, open = [], recent = 0 }) {
  if (!from) return 'Shed could not tell which session is asking. Run this from inside an agent session that Shed lists.';
  if (!to) return 'There is no session with that id. Run `shed sessions` to see the open ones.';
  if (from.id === to.id) return 'That is your own session.';
  if (to.liveState === 'history') return 'That session is not open. Only open sessions can be messaged.';
  if (open.some(x => x.from === to.id && x.to === from.id)) return 'That session is waiting for your answer right now. Put the answer in your reply instead of messaging it.';
  if (open.some(x => x.from === from.id && x.to === to.id)) return 'You already have a message waiting on that session. Run `shed reply <id>` to keep waiting for it.';
  if (depthFor(from.id, open) >= MAX_DEPTH) return `This conversation already passes through ${MAX_DEPTH} sessions. Answer with what you have.`;
  if (recent >= HOURLY_LIMIT) return `This session has sent ${HOURLY_LIMIT} messages in the last hour. Wait a while before sending more.`;
  return '';
}
// A session answering a message is one hop deeper than the session that asked it.
export function depthFor(sessionId, open) {
  const answering = open.find(x => x.to === sessionId);
  return answering ? (answering.depth || 0) + 1 : 0;
}

export function exchangeStore(dataDir) {
  const file = path.join(dataDir, 'exchanges.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
  const save = () => fs.writeFileSync(file, JSON.stringify(list.slice(0, KEEP)), { mode:0o600 });
  return {
    all:() => list,
    open:() => list.filter(x => x.kind !== 'intro' && ['sending', 'waiting'].includes(x.status)),
    get:id => list.find(x => x.id === id),
    sentWithin:(sessionId, ms) => list.filter(x => x.from === sessionId && Date.now() - Date.parse(x.createdAt) < ms).length,
    add(exchange) { list.unshift(exchange); save(); return exchange; },
    // Follows each exchange's task: delivered and answered, or failed. Returns true when anything changed.
    sync(taskFor) {
      let changed = false;
      for (const x of list) {
        if (!['sending', 'waiting'].includes(x.status)) continue;
        const task = taskFor(x.taskId);
        const next = !task ? { status:'failed', error:'The message was lost.' }
          : task.status === 'completed' ? { status:'answered', reply:String(task.output || '').trim().slice(-20000), answeredAt:task.updatedAt }
          : ['failed', 'cancelled'].includes(task.status) ? { status:'failed', error:task.error || 'The other session did not take the message.' }
          : { status:task.starting ? 'sending' : 'waiting' };
        if (Object.entries(next).some(([k, v]) => x[k] !== v)) { Object.assign(x, next); changed = true; }
      }
      if (changed) save();
      return changed;
    },
  };
}
// What pages need to draw an exchange: no full replies, just enough for a line.
export const exchangeSummary = x => ({ id:x.id, from:x.from, to:x.to, kind:x.kind, status:x.status, message:x.message.slice(0, 300), reply:(x.reply || '').slice(0, 300), error:(x.error || '').slice(0, 200), createdAt:x.createdAt, answeredAt:x.answeredAt || null, taskId:x.taskId });
