import { spawn } from 'node:child_process';

// One long-lived JavaScript-for-Automation process talks to Terminal for the whole server. Starting osascript for every
// read or keystroke costs ~150 ms; here a read is a single Apple event (a tab's properties: tty, processes and history
// together), about 20 ms, because each Apple event to Terminal waits for its next screen refresh (~16.6 ms).
// Requests are JSON lines on stdin and answers JSON lines on stdout, matched by id.
const SOURCE = String.raw`
ObjC.import('Foundation');
const T = Application('Terminal');
const input = $.NSFileHandle.fileHandleWithStandardInput, output = $.NSFileHandle.fileHandleWithStandardOutput;
const where = new Map();
function reply(value) { output.writeData($(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
// Finished tabs keep their old tty name, which macOS reuses for new windows, so a tab only counts while it has processes.
function locate(tty) {
  const ids = T.windows.id(), ttys = T.windows.tabs.tty();
  for (let w = 0; w < ttys.length; w++) for (let t = 0; t < ttys[w].length; t++) {
    if (ttys[w][t] !== tty) continue;
    const tab = T.windows.byId(ids[w]).tabs[t], props = tab.properties();
    if (props.processes.length > 0) { where.set(tty, { id:ids[w], index:t }); return { tab, props }; }
  }
  where.delete(tty);
  return null;
}
function findTab(tty) {
  const known = where.get(tty);
  if (known) {
    try {
      const tab = T.windows.byId(known.id).tabs[known.index], props = tab.properties();
      if (props.tty === tty && props.processes.length > 0) return { tab, props };
    } catch (e) { /* The window closed; look again. */ }
  }
  return locate(tty);
}
function handle(req) {
  if (req.op === 'read') { const found = findTab(req.tty); return found ? found.props.history : null; }
  if (req.op === 'type') { const found = findTab(req.tty); if (!found) return 'missing'; T.doScript(req.text, { in:found.tab }); return 'ok'; }
  if (req.op === 'open') { const tab = T.doScript(req.command); return tab.tty(); }
  throw new Error('Unknown request.');
}
let buffer = '';
while (true) {
  const data = input.availableData;
  if (Number(data.length) === 0) break;
  buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let req;
    try { req = JSON.parse(line); } catch (e) { continue; }
    try { reply({ id:req.id, ok:true, value:handle(req) }); }
    catch (e) { reply({ id:req.id, ok:false, error:String(e && e.message || e) }); }
  }
}
`;

let worker = null, nextId = 0;
const waiting = new Map();
function start() {
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SOURCE], { stdio:['pipe', 'pipe', 'pipe'] });
  let buffer = '', errors = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const entry = waiting.get(msg.id);
      if (!entry) continue;
      waiting.delete(msg.id); clearTimeout(entry.timer);
      msg.ok ? entry.resolve(msg.value) : entry.reject(new Error(msg.error));
    }
  });
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
  const fail = reason => {
    if (worker === child) worker = null;
    for (const [id, entry] of waiting) if (entry.child === child) { waiting.delete(id); clearTimeout(entry.timer); entry.reject(new Error(reason)); }
  };
  child.on('exit', () => fail(errors.trim() || 'The Terminal helper stopped.'));
  child.on('error', error => fail(error.message));
  child.stdin.on('error', () => {});
  child.unref(); child.stdout.unref?.(); child.stderr.unref?.();
  return child;
}

// Sends one request. A request that takes too long kills the helper (the next call starts a fresh one), so a hung
// Apple event can never block Terminal access for good.
export function terminalCall(op, args = {}, { timeoutMs = 10000 } = {}) {
  if (!worker || worker.exitCode !== null) worker = start();
  const child = worker, id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id); child.kill();
      if (worker === child) worker = null;
      reject(new Error('Terminal took too long to answer.'));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer, child });
    child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
  });
}

export function stopTerminalWorker() { worker?.kill(); worker = null; }
