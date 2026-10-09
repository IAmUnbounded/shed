import { renderMarkdown } from './markdown.js';
const state = { sessions: [], tasks: [], available: {}, health: {}, view: 'inbox', filter: 'all', selectedSession: null, selectedTask: null, previewTimer: null };
// Messages sent from Shed, shown in the conversation until the session's transcript records them.
state.pending = [];
state.v = {}; // last version of each polled resource
state.sessionLimit = 60;
// A 32-bit FNV-1a fingerprint: enough to tell "same HTML as last time" without storing the HTML a second time.
function fingerprint(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); } return `${h >>> 0}:${text.length}`; }
const harnessNames = { codex:'Codex', claude:'Claude Code', gemini:'Gemini', pi:'Pi', opencode:'OpenCode' };
const modelState = { configs:{}, draft:null };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const relative = date => { const diff = Math.max(0, Date.now() - Date.parse(date)); const m = Math.floor(diff / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : m < 10080 ? `${Math.floor(m / 1440)}d ago` : new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const projectName = cwd => cwd ? cwd.split('/').filter(Boolean).pop() : 'Unknown project';
// While the Mac is restarting Shed or is unreachable, requests fail fast and a small banner says so, instead of the
// page silently hanging. The banner clears on the next request that gets through.
function setOffline(offline) { document.getElementById('reconnecting')?.classList.toggle('hidden', !offline); }
async function api(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try { res = await fetch(url, { credentials:'same-origin', headers:{ 'Content-Type':'application/json' }, signal:controller.signal, ...options }); }
  catch (error) { setOffline(true); throw new Error(error.name === 'AbortError' ? 'Your Mac is taking too long to answer. Try again in a moment.' : 'Cannot reach your Mac right now. Shed may be restarting.'); }
  finally { clearTimeout(timer); }
  let data;
  try { data = await res.json(); }
  catch { setOffline(res.status >= 500); throw new Error(res.status >= 500 ? 'Cannot reach your Mac right now. Shed may be restarting.' : 'Unexpected response from your Mac.'); }
  setOffline(false);
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function symbol(harness) { return `<span class="harness-symbol ${escapeHtml(harness)}">${({codex:'◇',claude:'✳',gemini:'✦',pi:'π',opencode:'◎'})[harness] || '?'}</span>`; }
function showFeedback(message) { const el = $('#feedback'); el.textContent = message; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 6000); }
const pairCode = (() => { const match = location.hash.match(/^#pair=([\w-]{10,})$/); if (match) history.replaceState(null, '', location.pathname + location.search); return match?.[1] || ''; })();
let waitTimer = null;
function showWaiting(name) {
  $('#auth-form').classList.add('hidden'); $('#auth-waiting').classList.remove('hidden');
  $('#auth-waiting-name').textContent = name || 'this device';
  clearInterval(waitTimer);
  waitTimer = setInterval(async () => {
    try { const { status } = await api('/api/auth/device'); if (status === 'approved') { clearInterval(waitTimer); hideWaiting(); init(); } else if (status === 'none') { clearInterval(waitTimer); hideWaiting(); } } catch {}
  }, 3000);
}
function hideWaiting() { $('#auth-waiting').classList.add('hidden'); $('#auth-form').classList.remove('hidden'); }
$('#auth-waiting-cancel').addEventListener('click', () => { clearInterval(waitTimer); hideWaiting(); });
async function showAuth() {
  $('#auth-screen').classList.remove('hidden');
  $('#auth-password').focus();
  try {
    const status = await api('/api/auth/status');
    const configured = Boolean(status.passwordConfigured);
    const canSetup = Boolean(status.canSetup);
    $('#auth-copy').textContent = configured ? 'Sign in with your Shed password.' : canSetup ? 'Create a password once, then use it everywhere.' : 'Open Shed on the Mac once to create the password.';
    $('#show-password-setup').classList.toggle('hidden', !canSetup);
    const device = await api('/api/auth/device');
    if (device.status === 'pending') showWaiting(device.name);
  } catch {}
}
function hideAuth() { $('#auth-screen').classList.add('hidden'); }
function setView(view) { state.view = view; $('#phone-message').classList.toggle('hidden', view !== 'inbox'); $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== `view-${view}`)); $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view)); $('#page-name').textContent = ({ inbox:'Command center', sessions:'Sessions', activity:'Activity', settings:'Settings' })[view]; const url = new URL(location.href); if (view === 'inbox') url.searchParams.delete('view'); else url.searchParams.set('view', view); history.replaceState(null, '', url); document.querySelector('.sidebar').classList.remove('open'); $('#mobile-scrim').classList.add('hidden'); render(); }
function renderHarnesses() {
  const names = { codex:'Codex', claude:'Claude Code', gemini:'Gemini', pi:'Pi', opencode:'OpenCode' };
  const labels = { ready:'READY', needs_auth:'SIGN IN', offline:'OFFLINE', unknown:'CHECK', checking:'CHECKING' };
  $('#harness-list').innerHTML = Object.keys(names).filter(name => state.available[name]).map(name => {
    const health = state.health[name] || { state:'checking', detail:'Checking the CLI' };
    const label = name === 'opencode' && health.state === 'needs_auth' ? 'CONNECT' : labels[health.state] || 'CHECK';
    const checked = health.checkedAt ? ` · Checked ${new Date(health.checkedAt).toLocaleTimeString()}` : '';
    return `<div class="harness-row" title="${escapeHtml(health.detail + checked)}">${symbol(name)}<span>${names[name]}</span>${['needs_auth', 'unknown'].includes(health.state) ? `<button class="health-${escapeHtml(health.state)} sign-in" data-login="${name}" title="${escapeHtml(health.detail)}: opens the sign-in on the Mac">${label}</button>` : `<small class="health-${escapeHtml(health.state)}">${label}</small>`}${health.state === 'ready' ? `<button class="harness-start" data-start="${name}" title="Start a new ${names[name]} session" aria-label="Start a new ${names[name]} session">+</button>` : ''}</div>`;
  }).join('');
  $('#desktop-name').textContent = state.hostname || 'This desktop';
  const ready = state.laya?.ready, loading = state.laya?.state === 'loading';
  $('#router-status').innerHTML = `<span>${ready ? '✦ Laya routing ready' : loading ? '◌ Laya loading locally' : '◇ Local fallback active'}</span><button id="configure-laya">Manage ↗</button>`;
  $('#phone-url').textContent = state.phoneUrl || 'Unavailable';
  const remote = $('#remote-url');
  remote.textContent = state.remoteUrl || 'Secure link unavailable';
  remote.href = state.remoteUrl || '#';
  remote.classList.toggle('unavailable', !state.remoteUrl);
  $('#laya-status-copy').textContent = ready ? 'The open Laya model is loaded locally. Session, harness, and model routing are ready.' : loading ? 'Downloading or loading the local Laya model. Local matching remains available while it starts.' : `Laya is not loaded${state.laya?.error ? `: ${state.laya.error}` : '.'}`;
  $('#laya-status-badge').textContent = ready ? 'LOCAL · READY' : loading ? 'LOADING' : 'FALLBACK';
  $('#laya-status-badge').className = `badge ${ready ? 'completed' : 'running'}`;
  renderHealthDetails();
}
// Dropdowns are refreshed every few seconds. Rebuilding their options resets an open list on phones (it jumps
// back to the top), so options are only replaced when they changed, and never while that dropdown is in use.
function setOptions(select, html) {
  if (select.dataset.options === html) return;
  if (document.activeElement === select) { select.dataset.pendingOptions = html; return; }
  const value = select.value;
  select.innerHTML = html; select.dataset.options = html;
  if ([...select.options].some(o => o.value === value)) select.value = value;
}
document.addEventListener('focusout', e => {
  const select = e.target;
  if (select instanceof HTMLSelectElement && select.dataset.pendingOptions) { const html = select.dataset.pendingOptions; delete select.dataset.pendingOptions; setOptions(select, html); }
});
function renderHarnessAvailability() { const names = {codex:'Codex',claude:'Claude Code',gemini:'Gemini',pi:'Pi',opencode:'OpenCode'}; const installed = Object.keys(names).filter(name => state.available[name]); const select = $('#harness-select'); const current = select.value; setOptions(select, '<option value="auto">✦ Laya chooses</option>' + installed.map(name => `<option value="${name}">${names[name]}</option>`).join('')); select.value = installed.includes(current) ? current : 'auto'; const editor = $('#model-editor-harness'); setOptions(editor, installed.map(name => `<option value="${name}">${names[name]}</option>`).join('')); if (!installed.length) setOptions(editor, '<option value="">No installed harnesses</option>'); }
function updateHarnessReadiness() { const labels = { needs_auth:'sign in', offline:'offline', unknown:'check login', checking:'checking' }; const select = $('#harness-select'); for (const option of select.options) { if (option.value === 'auto') continue; const status = state.health[option.value]?.state || 'checking'; const label = `${({codex:'Codex',claude:'Claude Code',gemini:'Gemini',pi:'Pi',opencode:'OpenCode'})[option.value]}${status === 'ready' ? '' : ` · ${option.value === 'opencode' && status === 'needs_auth' ? 'connect provider' : labels[status] || 'unavailable'}`}`; if (option.disabled !== (status !== 'ready')) option.disabled = status !== 'ready'; if (option.textContent !== label) option.textContent = label; } if (select.selectedOptions[0]?.disabled) { select.value = 'auto'; renderModelChoices(); } }
function renderHealthDetails() { const issues = Object.entries(state.health).filter(([name, status]) => state.available[name] && status.state !== 'ready' && status.state !== 'checking'); if (issues.length) $('#harness-list').insertAdjacentHTML('beforeend', `<div class="harness-health-details">${issues.map(([name, status]) => `<div><b>${escapeHtml(({codex:'Codex',claude:'Claude Code',gemini:'Gemini',pi:'Pi',opencode:'OpenCode'})[name])}:</b> ${escapeHtml(status.detail)}</div>`).join('')}</div>`); }
async function refreshHarnessHealth() { try { const data = await api('/api/harness-health'); state.health = data.harnesses || {}; renderHarnesses(); updateHarnessReadiness(); syncPhoneHarness(); } catch (error) { if (error.message === 'Authentication required.') showAuth(); } }
function renderProjects() { const select = $('#project-select'); const current = select.value; const cwds = [...new Set(state.sessions.map(s => s.cwd).filter(Boolean))].sort((a,b) => projectName(a).localeCompare(projectName(b))); setOptions(select, '<option value="">Shed workspace</option><option value="__new__">+ New workspace</option>' + cwds.map(cwd => `<option value="${escapeHtml(cwd)}">${escapeHtml(projectName(cwd))}</option>`).join('')); select.value = [...select.options].some(option => option.value === current) ? current : ''; toggleNewWorkspace(); }
function toggleNewWorkspace() { $('#new-workspace-row').classList.toggle('hidden', $('#project-select').value !== '__new__'); }
function modelOptions(harness) { return (modelState.configs[harness]?.models || []).filter(model => model.enabled).map(model => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label || model.id)}</option>`).join(''); }
function renderModelChoices() {
  const select = $('#model-select'), current = select.value;
  setOptions(select, '<option value="">✦ Laya chooses</option>' + ($('#harness-select').value === 'auto' ? '' : modelOptions($('#harness-select').value)));
  select.value = [...select.options].some(option => option.value === current) ? current : '';
  if (state.selectedSession) {
    const session = state.selectedSession, names = {codex:'Codex',claude:'Claude Code',gemini:'Gemini',pi:'Pi',opencode:'OpenCode'};
    const routeSelect = $('#followup-route'), previousRoute = routeSelect.value;
    const others = Object.keys(names).filter(name => name !== session.harness && state.available[name] && state.health[name]?.state === 'ready');
    setOptions(routeSelect, `<option value="auto">Stay in ${escapeHtml(names[session.harness] || session.harness)}</option>` + others.map(name => `<option value="${name}">Hand off to ${names[name]}</option>`).join(''));
    routeSelect.value = [...routeSelect.options].some(option => option.value === previousRoute) ? previousRoute : 'auto';
    const target = ['auto', 'stay'].includes(routeSelect.value) ? session.harness : routeSelect.value;
    const followup = $('#followup-model'), previous = followup.value;
    const openCodex = target === 'codex' && session.harness === 'codex' && session.liveState !== 'history' && !session.tty;
    const keepsModel = ['claude', 'codex'].includes(target) && target === session.harness && Boolean(session.tty);
    const current = keepsModel ? `Keep session model${session.currentModel ? ` · ${session.currentModel}` : ''}` : session.currentModel ? `Laya chooses · now ${session.currentModel}` : 'Laya chooses';
    const liveTerminal = keepsModel && Boolean(session.tty);
    setOptions(followup, openCodex || liveTerminal ? `<option value="">${liveTerminal ? escapeHtml(current) : 'Current session model'}</option>` : `<option value="">✦ ${escapeHtml(current)}</option>` + modelOptions(target));
    followup.value = [...followup.options].some(option => option.value === previous) ? previous : '';
    followup.disabled = openCodex || liveTerminal;
  }
}
function setEditorHarness(harness) {
  modelState.draft = structuredClone(modelState.configs[harness] || { models:[], defaultModel:'' });
  renderModelEditor();
}
function renderModelEditor() {
  const draft = modelState.draft;
  if (!draft) return;
  if (draft.defaultModel && !draft.models.some(model => model.id === draft.defaultModel && model.enabled)) draft.defaultModel = '';
  $('#model-rows').innerHTML = draft.models.length ? '<div class="model-row header"><span>MODEL ID</span><span>LABEL</span><span>WHEN TO USE IT</span><span>ON</span></div>' + draft.models.map((model, index) => `<div class="model-row" data-index="${index}"><input type="text" data-field="id" value="${escapeHtml(model.id)}" placeholder="provider/model"><input type="text" data-field="label" value="${escapeHtml(model.label)}" placeholder="Display name"><input class="model-description" type="text" data-field="description" value="${escapeHtml(model.description)}" placeholder="When should Laya choose it?"><label class="enabled"><input type="checkbox" data-field="enabled" ${model.enabled ? 'checked' : ''}> ON</label><button type="button" data-remove="${index}" title="Remove model">×</button></div>`).join('') : '<div class="model-empty">No models added. Add two or more to let Laya choose between them.</div>';
  setOptions($('#default-model'), '<option value="">Harness default</option>' + draft.models.filter(model => model.id && model.enabled).map(model => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label || model.id)}</option>`).join(''));
  $('#default-model').value = draft.defaultModel;
}
async function loadModels() {
  const data = await api('/api/models');
  modelState.configs = data.configs;
  renderModelChoices();
  setEditorHarness($('#model-editor-harness').value);
}
function sessionRow(s) { const live = s.liveState !== 'history'; return `<button class="session-row ${live ? 'is-live' : ''}" data-session="${escapeHtml(s.id)}">${symbol(s.harness)}<div><div class="title"><span class="title-copy">${escapeHtml(s.title)}</span>${live ? `<span class="live-pill ${escapeHtml(s.liveState)}">${s.liveState === 'working' ? 'WORKING' : 'OPEN'}</span>` : ''}</div><div class="sub" title="${escapeHtml(s.cwd || '')}">${escapeHtml(projectName(s.cwd))}</div></div><span class="harness-name">${escapeHtml(s.harness === 'claude' ? 'Claude Code' : s.harness)}</span><span class="time">${relative(s.updatedAt)}</span><span class="arrow">↗</span></button>`; }
function taskCard(t) { return `<div class="task-card" data-task="${escapeHtml(t.id)}"><div class="task-card-top">${symbol(t.harness)}<span>${escapeHtml(t.harness === 'claude' ? 'Claude Code' : t.harness)} · ${escapeHtml(t.model || 'default model')}</span><span class="badge ${escapeHtml(t.status)}" style="margin-left:auto">${escapeHtml(t.status)}</span></div><div class="task-card-title">${escapeHtml(t.title)}</div><div class="task-card-meta"><span>${escapeHtml(projectName(t.cwd))}</span><span>${relative(t.createdAt)} ↗</span></div></div>`; }
// Live sessions are pixel agents, one per harness, in the spirit of Claude Code's Clawd:
// they type on a laptop while working, sip coffee while waiting, and hold up a sign when they need your OK.
// Sprites are 16-wide grids; B is body, E eye, H highlight, D detail, G screen glow.
const agentSprites = {
  claude: { colors:{ B:'#da7758', E:'#1d1a17' }, rows:[
    '................',
    '...BBBBBBBBBB...',
    '...BBBBBBBBBB...',
    '...BBEBBBBEBB...',
    '...BBEBBBBEBB...',
    '.BBBBBBBBBBBBBB.',
    '.BBBBBBBBBBBBBB.',
    '...BBBBBBBBBB...',
    '...BBBBBBBBBB...',
    '....B.B..B.B....',
    '....B.B..B.B....'] },
  codex: { colors:{ B:'#2d2f33', E:'#7ee2c0', D:'#7ee2c0', H:'#10a37f', A:'#8e8ea0' }, rows:[
    '.......H........',
    '.......A........',
    '...BBBBBBBBBB...',
    '..BBBBBBBBBBBB..',
    '..BBBEBBBBEBBB..',
    '..BBBEBBBBEBBB..',
    '..BBBBBBBBBBBB..',
    '..BBBBDBBDBBBB..',
    '...BBBBDDBBBB...',
    '.....BB..BB.....',
    '.....BB..BB.....'] },
  gemini: { colors:{ B:['#4c8df6', '#8f6cf6'], E:'#ffffff' }, rows:[
    '.......BB.......',
    '......BBBB......',
    '.....BBBBBB.....',
    '...BBBBBBBBBB...',
    '.BBBBEBBBBEBBBB.',
    'BBBBBEBBBBEBBBBB',
    '.BBBBBBBBBBBBBB.',
    '...BBBBBBBBBB...',
    '.....BBBBBB.....',
    '......BBBB......',
    '.......BB.......'] },
  opencode: { colors:{ B:'#2b2f33', D:'#4d5357', G:'#3ddc97', E:'#3ddc97' }, rows:[
    '..BBBBBBBBBBBB..',
    '..BDDDDDDDDDDB..',
    '..BDGDDDDDDDDB..',
    '..BDDGDDDDDDDB..',
    '..BDGDDEEEDDDB..',
    '..BDDDDDDDDDDB..',
    '..BBBBBBBBBBBB..',
    '......BBBB......',
    '....BBBBBBBB....',
    '................',
    '................'] },
  pi: { colors:{ B:'#8a8579', E:'#1d1a17', H:'#b5afa2' }, rows:[
    '................',
    '.....BBBBBB.....',
    '...BBBBBBBBBB...',
    '..BBHBBBBBBBBB..',
    '..BBBEBBBBEBBB..',
    '.BBBBEBBBBEBBBB.',
    '.BBBBBBBBBBBBBB.',
    '.BBBBBBBBBBBBBB.',
    '..BBBBBBBBBBBB..',
    '...BB......BB...',
    '................'] },
};
// Merges each row's runs of one color into a single rect so a sprite is a few dozen elements, not hundreds.
function pixelRects(rows, colors, x0, y0, eyeClass) {
  let out = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const key = row[x];
      if (key === '.') { x++; continue; }
      let end = x; while (row[end + 1] === key) end++;
      const fill = Array.isArray(colors[key]) ? mixColor(colors[key][0], colors[key][1], y / (rows.length - 1)) : colors[key];
      out += `<rect${key === 'E' ? ` class="${eyeClass}"` : ''} x="${x0 + x}" y="${y0 + y}" width="${end - x + 1}" height="1" fill="${fill}"/>`;
      x = end + 1;
    }
  });
  return out;
}
function mixColor(a, b, t) {
  const p = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
}
function agentSvg(harness, mood) {
  const sprite = agentSprites[harness] || agentSprites.pi;
  const body = Array.isArray(sprite.colors.B) ? sprite.colors.B[1] : sprite.colors.B;
  const props = {
    working:`<g class="laptop"><rect x="7" y="12" width="10" height="5" fill="#2c2b27"/><rect class="screen" x="8" y="13" width="8" height="3" fill="#a6e8bd"/><rect class="cursor" x="9" y="14" width="2" height="1" fill="#2c2b27"/><rect x="5" y="17" width="14" height="1" fill="#57534a"/></g><rect class="hand l" x="6" y="16" width="2" height="1" fill="${body}"/><rect class="hand r" x="16" y="16" width="2" height="1" fill="${body}"/>`,
    open:`<g class="mug"><rect x="19" y="14" width="3" height="4" fill="#d8ccb6"/><rect x="19" y="14" width="3" height="1" fill="#8a6a4f"/><rect x="22" y="15" width="1" height="2" fill="#d8ccb6"/><rect class="steam s1" x="20" y="12" width="1" height="1" fill="#b3ab9c"/><rect class="steam s2" x="21" y="11" width="1" height="1" fill="#b3ab9c"/></g>`,
    asking:`<g class="sign"><rect x="18" y="0" width="5" height="6" fill="#c2603f"/><rect x="17" y="1" width="7" height="4" fill="#c2603f"/><rect x="18" y="6" width="1" height="1" fill="#c2603f"/><rect x="20" y="1" width="1" height="2" fill="#fff"/><rect x="20" y="4" width="1" height="1" fill="#fff"/></g>`,
  }[mood] || '';
  return `<svg class="critter" viewBox="0 0 24 20" shape-rendering="crispEdges" aria-hidden="true">
    <rect class="shadow" x="5" y="18" width="14" height="1" fill="#2a262014"/>
    <g class="sprite">${pixelRects(sprite.rows, sprite.colors, 4, 4, 'eye')}</g>
    ${props}
  </svg>`;
}
const agentMoods = { working:['working', 'Typing away'], asking:['asking', 'Needs your OK'], open:['open', 'Waiting for you'] };
function agentCard(session, index) {
  const [mood, status] = agentMoods[session.liveState] || agentMoods.open;
  return `<button class="agent ${mood}" data-session="${escapeHtml(session.id)}" style="--d:${(index * 0.83) % 4}s" aria-label="${escapeHtml(`${harnessNames[session.harness] || session.harness} in ${projectName(session.cwd) || 'a project'}: ${status}. ${session.title}`)}">
    <span class="agent-stage"><span class="agent-harness">${escapeHtml(harnessNames[session.harness] || session.harness)}</span>${agentSvg(session.harness, mood)}</span>
    <span class="agent-name">${escapeHtml(projectName(session.cwd) || 'Untitled project')}</span>
    <span class="agent-status"><i></i>${status}</span>
    <span class="agent-title">${escapeHtml(session.title)}</span>
  </button>`;
}
function render() {
  $('#nav-session-count').textContent = state.sessions.length;
  const urgency = s => ({ asking:0, working:1 })[s.liveState] ?? 2;
  const live = state.sessions.filter(s => s.liveState !== 'history').sort((a,b) => urgency(a) - urgency(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  $('#active-count').textContent = live.length;
  const desk = live.length ? live.map(agentCard).join('') : `<div class="agent-empty">${agentSvg('pi', 'open')}<div><strong>No agents at their desks</strong><p>Start a session from the sidebar's + and it will show up here.</p></div></div>`;
  const deskPrint = fingerprint(desk);
  if ($('#active-sessions').dataset.print !== deskPrint) { $('#active-sessions').innerHTML = desk; $('#active-sessions').dataset.print = deskPrint; } // rebuilding every refresh would restart the animations
  $('#recent-sessions').innerHTML = state.sessions.filter(s => s.liveState === 'history').slice(0,6).map(sessionRow).join('') || '<div class="table-empty">No previous desktop sessions found yet.</div>';
  // The Sessions and Activity lists are long; build them only while they are on screen.
  if (state.view !== 'sessions') { if ($('#all-sessions').firstChild) $('#all-sessions').replaceChildren(); }
  else renderSessionList();
  if (state.view !== 'activity') { if ($('#activity-list').firstChild) $('#activity-list').replaceChildren(); }
  else renderActivity();
}
document.addEventListener('click', e => { if (e.target.id === 'show-more-sessions') { state.sessionLimit += 60; renderSessionList(); } });
$('#session-search').addEventListener('input', () => { state.sessionLimit = 60; });
function renderSessionList() {
  const query = $('#session-search').value.trim().toLowerCase();
  const filtered = state.sessions.filter(s => (state.filter === 'all' || (state.filter === 'live' ? s.liveState !== 'history' : s.harness === state.filter)) && (!query || `${s.title} ${s.lastPrompt} ${s.cwd} ${s.harness}`.toLowerCase().includes(query)))
    .sort((a,b) => (a.liveState === 'history' ? 1 : 0) - (b.liveState === 'history' ? 1 : 0) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  $('#session-results').textContent = `${filtered.length} session${filtered.length === 1 ? '' : 's'}`;
 $('#all-sessions').innerHTML = (filtered.slice(0, state.sessionLimit).map(sessionRow).join('') || '<div class="table-empty">No sessions match this search.</div>') + (filtered.length > state.sessionLimit ? `<button class="pill show-more" id="show-more-sessions" type="button">Show ${Math.min(60, filtered.length - state.sessionLimit)} more of ${filtered.length - state.sessionLimit}</button>` : '');
}
function renderActivity() {
  $('#activity-list').innerHTML = state.tasks.length ? state.tasks.map(t => `<div class="activity-item" data-task="${escapeHtml(t.id)}">${symbol(t.harness)}<div class="activity-main"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(projectName(t.cwd))} · ${escapeHtml(t.model || 'default model')} (${escapeHtml(t.modelSource || 'harness-default')}) · ${escapeHtml(t.routeSource || 'local')} route · ${relative(t.createdAt)}</small></div><span class="badge ${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></div>`).join('') : '<div class="empty-panel"><span class="empty-symbol">◷</span><div><strong>No tasks yet</strong><p>Sessions you start through Shed will appear here.</p></div></div>';
}
async function refresh() { if (document.hidden) return; try { const [s,t] = await Promise.all([api(`/api/sessions?v=${state.v.sessions || ''}`), api(`/api/tasks?v=${state.v.tasks || ''}`)]); let changed = false; if (!s.same) { state.sessions = s.sessions; state.v.sessions = s.v; changed = true; } if (!t.same) { state.tasks = t.tasks; state.v.tasks = t.v; changed = true; } if (changed) { renderProjects(); render(); } if (state.selectedTask) openTask(state.selectedTask, true); if (state.selectedSession) openSession(state.selectedSession.id, true); } catch (error) { if (error.message === 'Authentication required.') showAuth(); } }
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#auth-screen').classList.contains('hidden')) { refresh(); loadTerminal(); } });
async function init() { try { const me = await api('/api/me'); Object.assign(state, me); hideAuth(); renderHarnesses(); renderHarnessAvailability(); updateHarnessReadiness(); await Promise.all([refresh(), loadModels(), refreshHarnessHealth(), loadConnect()]); setupPush(); loadDevices(); openFromUrl(location.href); $('#phone-message').classList.toggle('hidden', state.view !== 'inbox'); const requestedView = new URL(location.href).searchParams.get('view'); if (['sessions','activity','settings'].includes(requestedView)) setView(requestedView); } catch (error) { if (error.message === 'Authentication required.') showAuth(); else showFeedback(error.message); } }
async function previewRoute() { const prompt = $('#prompt').value.trim(); if (prompt.length < 9) { $('#route-preview').classList.add('hidden'); return; } try { const selectedProject = $('#project-select').value; const data = await api('/api/route', { method:'POST', body:JSON.stringify({prompt, harness:$('#harness-select').value, model:$('#model-select').value, cwd:selectedProject === '__new__' ? '' : selectedProject, newWorkspace:selectedProject === '__new__' ? $('#new-workspace').value : '', newSession:true}) }); if ($('#prompt').value.trim() !== prompt) return; const route = data.route; $('#route-preview').innerHTML = `<span class="route-symbol">✦</span><span><b>Local preview:</b> New ${escapeHtml(route.harness)} session · ${escapeHtml(route.reason)} · ${escapeHtml(route.model || 'harness default')} model</span>`; $('#route-preview').classList.remove('hidden'); } catch { $('#route-preview').classList.add('hidden'); } }
async function sendTask(prompt, options = {}) { if (!prompt.trim()) return; const button = options.sessionId ? $('#followup-send') : $('#send-button'); button.disabled = true; try { const selectedProject = $('#project-select').value; const isNew = !options.sessionId; const {task} = await api('/api/tasks', { method:'POST', body:JSON.stringify({ prompt, harness:options.harness || $('#harness-select').value, model:options.model ?? (options.sessionId ? $('#followup-model').value : $('#model-select').value), cwd:options.cwd ?? (selectedProject === '__new__' ? '' : selectedProject), newWorkspace:isNew && selectedProject === '__new__' ? $('#new-workspace').value : '', newSession:isNew, sessionId:options.sessionId || null, followup:options.followup || 'auto', skipPermissions:options.sessionId ? $('#followup-skip').checked : $('#skip-permissions').checked }) }); $('#prompt').value = ''; $('#followup-prompt').value = ''; $('#followup-prompt').style.height = ''; state.followupPreviewKey = null; $('#followup-preview').classList.add('hidden'); $('#new-workspace').value = ''; $('#route-preview').classList.add('hidden');
  if (options.sessionId && !task.handoffFrom) { state.pending.push({ taskId:task.id, sessionId:options.sessionId, text:prompt.trim(), at:Date.now() }); state.pinBottom = true; await refresh(); return true; }
  state.followTask = task.id; await refresh(); openTask(task.id); return true; } catch (error) { showFeedback(error.message); return false; } finally { button.disabled = false; } }
// The conversation stays pinned to its newest message until the person scrolls up, and re-pins at the bottom.
let userScrollAt = 0;
['touchstart', 'wheel', 'keydown', 'mousedown'].forEach(type => $('#drawer-content').addEventListener(type, () => { userScrollAt = Date.now(); }, { passive:true }));
$('#drawer-content').addEventListener('scroll', () => {
  if (Date.now() - userScrollAt > 1500) return; // our own scrolling, not the person's
  const c = $('#drawer-content');
  state.pinBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 60;
}, { passive:true });
// The drawer refreshes every few seconds; only rebuild when something changed, and keep every scroll position when it does.
function setDrawerContent(html, force = false) {
  const el = $('#drawer-content');
  const print = fingerprint(html);
  if (!force && el.dataset.print === print) return false;
  const inner = [...el.querySelectorAll('.message-body')].map(b => ({ top:b.scrollTop, atBottom:b.scrollHeight - b.scrollTop - b.clientHeight < 24 }));
  el.innerHTML = html; el.dataset.print = print;
  if (!force) el.querySelectorAll('.message-body').forEach((b, i) => { const prior = inner[i]; if (prior) b.scrollTop = prior.atBottom && i === inner.length - 1 ? b.scrollHeight : prior.top; });
  return true;
}
function showPane(pane) {
  state.pane = pane;
  $$('#drawer-tabs button').forEach(b => b.classList.toggle('active', b.dataset.pane === pane));
  $('#drawer-content').classList.toggle('hidden', pane !== 'conversation');
  $('#drawer-terminal').classList.toggle('hidden', pane !== 'terminal');
  $('#drawer-files').classList.toggle('hidden', pane !== 'files');
  $('.drawer-composer').classList.toggle('in-terminal', pane !== 'conversation');
  $('#detail-drawer').classList.toggle('wide', pane === 'terminal');
  if (pane === 'terminal') setTimeout(() => loadTerminal(true), 0); // after openDrawer() has made the drawer visible
  if (pane === 'files') loadFiles();
}
// Devices signed in to Shed. Pending ones can only be approved on the Mac.
async function loadDevices() {
  try {
    const { devices, canApprove } = await api('/api/devices');
    state.devices = devices; state.canApprove = canApprove;
    $('#device-list').innerHTML = devices.map(d => `<div class="device-row ${d.status}"><div><b>${escapeHtml(d.name)}${d.current ? ' <span class="device-tag">This device</span>' : ''}${d.status === 'pending' ? ' <span class="device-tag pending">Waiting for approval</span>' : ''}</b><small>${d.local ? 'On this Mac' : `From ${escapeHtml(d.lastIp || 'unknown')}`} · last used ${relative(d.lastSeenAt)} · added ${relative(d.createdAt)}</small></div><div class="device-actions">${d.status === 'pending' && canApprove ? `<button class="send-button" data-approve="${escapeHtml(d.id)}" type="button">Approve</button>` : ''}${d.current ? '' : `<button class="pill" data-revoke="${escapeHtml(d.id)}" type="button">${d.status === 'pending' ? 'Deny' : 'Sign out'}</button>`}</div></div>`).join('') || '<p class="settings-note">No devices yet.</p>';
    const pending = canApprove ? devices.filter(d => d.status === 'pending') : [];
    const toast = $('#approve-toast');
    if (pending.length) { const d = pending[0]; toast.dataset.device = d.id; $('#approve-detail').textContent = `${d.name} from ${d.lastIp || 'an unknown address'}, ${relative(d.createdAt)}. Only approve it if this is you.`; }
    toast.classList.toggle('hidden', !pending.length);
  } catch {}
}
async function deviceAction(id, action) { try { await api(`/api/devices/${encodeURIComponent(id)}/${action}`, { method:'POST' }); } catch (error) { showFeedback(error.message); } loadDevices(); }
$('#device-list').addEventListener('click', e => { const a = e.target.closest('[data-approve]'), r = e.target.closest('[data-revoke]'); if (a) deviceAction(a.dataset.approve, 'approve'); if (r) deviceAction(r.dataset.revoke, 'revoke'); });
$('#approve-yes').addEventListener('click', () => deviceAction($('#approve-toast').dataset.device, 'approve'));
$('#approve-no').addEventListener('click', () => deviceAction($('#approve-toast').dataset.device, 'revoke'));
$('#revoke-others').addEventListener('click', async () => { try { await api('/api/devices/revoke-others', { method:'POST' }); loadDevices(); } catch (error) { showFeedback(error.message); } });
setInterval(() => { if ($('#auth-screen').classList.contains('hidden') && (state.local || state.view === 'settings')) loadDevices(); }, 5000);
// Notifications: Web Push through Shed's service worker. On iPhone this needs Shed on the Home Screen (iOS 16.4+).
const push = { registration:null, supported:'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext };
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function b64ToBytes(base64) { const pad = '='.repeat((4 - base64.length % 4) % 4); const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
async function currentSubscription() { try { return push.registration ? await push.registration.pushManager.getSubscription() : null; } catch { return null; } }
async function refreshNotifyUi() {
  const status = $('#notify-status'), toggle = $('#notify-toggle'), banner = $('#notify-banner');
  let subscribed = false, info = null;
  if (push.supported && push.registration) {
    const sub = await currentSubscription();
    try { info = await api(`/api/push?endpoint=${encodeURIComponent(sub?.endpoint || '')}`); } catch {}
    subscribed = Boolean(sub && info?.subscribed);
  }
  if (info?.prefs) { $('#notify-finished').checked = info.prefs.finished; $('#notify-asking').checked = info.prefs.asking; }
  const blockedOnIOS = isIOS && !standalone;
  const denied = 'Notification' in window && Notification.permission === 'denied';
  status.textContent = blockedOnIOS ? 'On iPhone, first add Shed to your Home Screen (Share → Add to Home Screen), then open it from there and turn notifications on.'
    : !push.supported ? (window.isSecureContext ? 'This browser does not support notifications.' : 'Notifications need the secure https link. Open Shed through the link under Phone access.')
    : denied ? 'Notifications are blocked for Shed in this browser’s settings. Allow them there, then come back.'
    : subscribed ? `On for this device.${info?.devices > 1 ? ` ${info.devices} devices get notifications.` : ''}` : 'Off for this device.';
  toggle.textContent = subscribed ? 'Turn off on this device' : 'Turn on notifications';
  toggle.disabled = !push.supported || blockedOnIOS || denied;
  $('#notify-test').classList.toggle('hidden', !subscribed);
  let dismissed = false; try { dismissed = localStorage.getItem('shed-notify-dismissed') === '1'; } catch {}
  const showBanner = !subscribed && !denied && !dismissed && (push.supported || blockedOnIOS) && matchMedia('(max-width: 700px)').matches;
  banner.classList.toggle('hidden', !showBanner);
  $('#notify-banner-copy').textContent = blockedOnIOS ? 'Add Shed to your Home Screen (Share → Add to Home Screen), open it from there, then turn on notifications.' : 'Get a notification when an agent finishes or asks for your OK.';
  $('#notify-banner-on').classList.toggle('hidden', blockedOnIOS);
}
async function enableNotifications() {
  try {
    const permission = await Notification.requestPermission(); // must run inside the tap
    if (permission !== 'granted') { showFeedback('Notifications were not allowed. You can allow them in this browser’s settings.'); return refreshNotifyUi(); }
    const { publicKey } = await api('/api/push');
    const sub = (await currentSubscription()) || await push.registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:b64ToBytes(publicKey) });
    await api('/api/push/subscribe', { method:'POST', body:JSON.stringify({ subscription:sub.toJSON(), label:`${isIOS ? 'iPhone' : navigator.platform || 'Browser'}` }) });
  } catch (error) { showFeedback(`Could not turn on notifications: ${error.message}`); }
  refreshNotifyUi();
}
async function disableNotifications() {
  const sub = await currentSubscription();
  if (sub) { await api('/api/push/unsubscribe', { method:'POST', body:JSON.stringify({ endpoint:sub.endpoint }) }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  refreshNotifyUi();
}
$('#notify-toggle').addEventListener('click', async () => { (await currentSubscription()) && !$('#notify-toggle').textContent.startsWith('Turn on') ? disableNotifications() : enableNotifications(); });
$('#notify-banner-on').addEventListener('click', enableNotifications);
$('#notify-banner-dismiss').addEventListener('click', () => { try { localStorage.setItem('shed-notify-dismissed', '1'); } catch {} $('#notify-banner').classList.add('hidden'); });
$('#notify-test').addEventListener('click', async () => {
  const sub = await currentSubscription(); if (!sub) return;
  // Re-subscribing sends the welcome notification again, which doubles as a test.
  await api('/api/push/subscribe', { method:'POST', body:JSON.stringify({ subscription:sub.toJSON(), label:isIOS ? 'iPhone' : 'Browser' }) }).catch(error => showFeedback(error.message));
});
['notify-finished', 'notify-asking'].forEach(id => $(`#${id}`).addEventListener('change', () => api('/api/push/prefs', { method:'POST', body:JSON.stringify({ finished:$('#notify-finished').checked, asking:$('#notify-asking').checked }) }).catch(error => showFeedback(error.message))));
async function setupPush() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    try { push.registration = await navigator.serviceWorker.register('/sw.js'); } catch { push.supported = false; }
    navigator.serviceWorker.addEventListener('message', event => { if (event.data?.type === 'open') openFromUrl(event.data.url); });
  }
  refreshNotifyUi();
}
// A notification opens Shed at /?session=… or /?task=…
function openFromUrl(href) {
  const url = new URL(href, location.href), session = url.searchParams.get('session'), task = url.searchParams.get('task');
  if (session) openSession(session); else if (task) openTask(task);
  if (session || task) { url.searchParams.delete('session'); url.searchParams.delete('task'); history.replaceState(null, '', url); }
}
// Files: what an agent made in its project folder (videos, images, PDFs…), with preview and download.
const fileIcon = kind => ({ video:'▶', image:'▣', audio:'♪', application:'⇩', text:'≡' })[kind] || '⇩';
const fileSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
async function fetchFiles(base) {
  try { const data = await api(`${base}/files`); state.files = { key:base, list:data.files || [], root:data.root }; }
  catch { state.files = { key:base, list:[] }; }
  return state.files;
}
const fileUrl = (base, file, download) => `${base}/file?path=${encodeURIComponent(file)}${download ? '&download=1' : ''}`;
function fileChips(text) {
  const { key, list } = state.files || {};
  if (!key || !list?.length || !text) return '';
  const mentioned = new Set((String(text).match(/[\w.~\-/]+\.(?:mp4|mov|webm|m4v|gif|png|jpe?g|webp|svg|mp3|wav|m4a|pdf|zip|csv|srt|pptx|docx|xlsx)\b/gi) || []).map(m => m.split('/').pop().toLowerCase()));
  const hits = list.filter(f => mentioned.has(f.path.split('/').pop().toLowerCase())).slice(0, 6);
  return hits.length ? `<div class="file-chips">${hits.map(f => `<a class="file-chip" href="${fileUrl(key, f.path, true)}" download title="Download ${escapeHtml(f.path)}"><span>${fileIcon(f.kind)}</span>${escapeHtml(f.path.split('/').pop())}<small>${fileSize(f.size)}</small></a>`).join('')}</div>` : '';
}
async function loadFiles() {
  const session = state.selectedSession, box = $('#drawer-files');
  if (!session) return;
  const base = `/api/sessions/${encodeURIComponent(session.id)}`;
  box.innerHTML = '<div class="files-empty">Looking for files in this project…</div>';
  const { list, root } = await fetchFiles(base);
  if (state.selectedSession?.id !== session.id) return;
  box.innerHTML = list.length
    ? `<div class="files-head">Newest files in <b>${escapeHtml(root || projectName(session.cwd))}</b></div>${list.map((f, i) => `<div class="file-row" data-file-index="${i}"><button class="file-main" type="button" data-preview="${i}"><span class="file-icon ${escapeHtml(f.kind)}">${fileIcon(f.kind)}</span><span class="file-name"><b>${escapeHtml(f.path.split('/').pop())}</b><small>${escapeHtml(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) + ' · ' : '')}${fileSize(f.size)} · ${relative(f.modifiedAt)}</small></span></button><a class="file-download" href="${fileUrl(base, f.path, true)}" download aria-label="Download ${escapeHtml(f.path)}">Download</a><div class="file-preview hidden"></div></div>`).join('')}`
    : '<div class="files-empty">No videos, images, PDFs or other shareable files in this project yet.</div>';
}
$('#drawer-files').addEventListener('click', e => {
  const button = e.target.closest('[data-preview]');
  if (!button) return;
  const f = state.files.list[Number(button.dataset.preview)], row = button.closest('.file-row'), preview = row.querySelector('.file-preview');
  if (!preview.classList.contains('hidden')) { preview.classList.add('hidden'); preview.innerHTML = ''; return; }
  const src = fileUrl(state.files.key, f.path, false);
  preview.innerHTML = f.kind === 'video' ? `<video src="${src}" controls playsinline preload="metadata"></video>`
    : f.kind === 'image' ? `<img src="${src}" alt="${escapeHtml(f.path)}">`
    : f.kind === 'audio' ? `<audio src="${src}" controls></audio>`
    : `<a class="text-action" href="${src}" target="_blank" rel="noopener">Open ${escapeHtml(f.path.split('/').pop())} ↗</a>`;
  preview.classList.remove('hidden');
});
// The terminal pane shows either a session's terminal or a harness sign-in window.
function terminalTarget() {
  if (state.login) return { key:`login:${state.login.harness}`, tty:state.login.tty, url:`/api/harnesses/${state.login.harness}/terminal` };
  const task = state.selectedTask && state.tasks.find(t => t.id === state.selectedTask);
  if (task?.tty) return { key:`task:${task.id}`, tty:task.tty, url:`/api/tasks/${encodeURIComponent(task.id)}/terminal` };
  const session = state.selectedSession;
  return session?.tty ? { key:session.id, tty:session.tty, url:`/api/sessions/${encodeURIComponent(session.id)}/terminal` } : null;
}
// Terminal apps pad lines to the window width and wrap long text themselves (continuation lines indented by two
// spaces). On a phone that wraps twice, so padding is trimmed, wrapped paragraphs are rejoined and long rules shortened.
const wideTerminal = matchMedia('(min-width: 901px)');
function tidyTerminal(text) {
  const lines = text.split('\n').map(line => line.replace(/\s+$/, ''));
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const continues = prev && prev.length >= 60 && /^  [^\s⏺❯›•✻✳⎿─│┃▶▷⏵⏸·*✔✗!>-]/.test(line) && !/^\s*$/.test(prev);
    if (continues) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[─━]{24,}/g, '─'.repeat(24));
}
async function loadTerminal(reset = false) {
  if (document.hidden) return;
  const target = terminalTarget(), view = $('#terminal-view'), scroller = $('#terminal-scroll');
  if (!target || state.pane !== 'terminal' || $('#detail-drawer').classList.contains('hidden')) return;
  if (reset) { view.textContent = 'Reading the terminal…'; $('#terminal-controls').classList.remove('asking'); }
  if (!state.login) $('#terminal-caption').textContent = `Live · ${target.tty.replace("/dev/", "")} on the Mac · updates every 2s`;
  try {
    const data = await api(`${target.url}?v=${reset ? '' : state.terminalV?.[target.key] || ''}`);
    if (terminalTarget()?.key !== target.key || data.same) return;
    state.terminalV = { [target.key]:data.v };
    const { text } = data;
    const screen = text.split('\n').slice(-20).join('\n');
    $('#terminal-controls').classList.toggle('asking', /Esc to cancel|Enter to confirm|❯\s*1\.|Would you like to|Press enter to confirm|›\s*1\.\s/i.test(screen));
    const atBottom = reset || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    // A wide desktop drawer shows the terminal exactly as laid out; a phone gets the reflowed version.
    view.textContent = wideTerminal.matches ? text.split('\n').map(line => line.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n') : tidyTerminal(text);

    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  } catch (error) { view.textContent = error.message; }
}
function openDrawer() { $('#detail-drawer').classList.remove('hidden'); $('#drawer-backdrop').classList.remove('hidden'); }
function closeDrawer() { $('#detail-drawer').classList.remove('wide'); state.selectedSession = null; state.selectedTask = null; state.login = null; $('#detail-drawer').classList.remove('login-mode'); $('#detail-drawer').classList.add('hidden'); $('#drawer-backdrop').classList.add('hidden'); }
// A sent message stays visible below the conversation, with its delivery state, until the transcript shows it.
function pendingMessages(session, messages) {
  const recorded = new Set(messages.filter(m => m.role === 'user').map(m => m.text.replace(/\s+/g, ' ').trim()));
  state.pending = state.pending.filter(p => !(p.sessionId === session.id && recorded.has(p.text.replace(/\s+/g, ' ').trim())) && Date.now() - p.at < 30 * 60 * 1000);
  return state.pending.filter(p => p.sessionId === session.id).map(p => {
    const task = state.tasks.find(t => t.id === p.taskId);
    const failed = task?.status === 'failed';
    const status = failed ? `Not delivered: ${task.error || 'see the task for details'}` : task?.waitingOn ? `Waiting for an answer in the Terminal tab: ${task.waitingOn}` : task?.status === 'completed' ? 'Delivered' : 'Sending to the terminal…';
    return `<div class="message user pending${failed ? ' failed' : ''}"><div class="message-label">YOU · just now</div><div class="message-body">${escapeHtml(p.text)}</div><div class="pending-status">${escapeHtml(status)}${failed ? ` <button class="text-action" data-task="${escapeHtml(p.taskId)}" type="button">Details</button>` : ''}</div></div>`;
  }).join('');
}
// The session's first message as a one-line topic: Markdown and line breaks removed, cut at a word boundary.
function topicLine(text, max = 160) {
  const plain = String(text || '').replace(/[`*_#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6)).replace(/[\s,;:.-]+$/, '')}…`;
}
async function openSession(id, silent = false) {
  try {
    const known = state.sessionV?.id === id ? state.sessionV.v : '';
    let data = await api(`/api/sessions/${encodeURIComponent(id)}?v=${silent ? known : ''}`);
    if (silent && state.selectedSession?.id !== id) return;
    if (data.same) {
      // The conversation has not changed; redraw only if a sent message's delivery status may have.
      if (!state.pending.some(p => p.sessionId === id)) return;
      data = state.sessionV.data;
    } else state.sessionV = { id, v:data.v, data };
    const { session, messages } = data;
    const content = $('#drawer-content');
    const priorScroll = content.scrollTop;
    const stickToBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 80;
    if (!silent) { state.followupPreviewKey = null; $('#followup-preview').classList.add('hidden'); $('#followup-route').value = 'auto'; $('#followup-model').value = ''; }
    state.selectedSession = session;
    state.selectedTask = null;
    if (!silent) { state.login = null; $('#detail-drawer').classList.remove('login-mode'); }
    renderModelChoices();
    const status = session.liveState === 'history' ? 'HISTORY' : session.liveState === 'working' ? 'WORKING NOW' : session.liveState === 'asking' ? 'NEEDS YOUR OK' : 'OPEN ON DESKTOP';
    $('#drawer-harness').innerHTML = `${symbol(session.harness)} <span style="vertical-align:middle;margin-left:7px">${escapeHtml(session.harness.toUpperCase())} · ${status}</span>`;
    const changed = setDrawerContent(`<header class="chat-head"><h2 class="drawer-title">${escapeHtml(projectName(session.cwd) || 'Untitled project')}</h2><p class="chat-topic" title="${escapeHtml(session.title)}">${escapeHtml(topicLine(session.title))}</p><div class="drawer-path">${escapeHtml(session.cwd || 'Unknown folder')} · updated ${relative(session.updatedAt)}</div></header>${messages.length ? messages.map(m => `<div class="message ${escapeHtml(m.role)}"><div class="message-label">${m.role === 'user' ? 'YOU' : escapeHtml(session.harness.toUpperCase())} ${m.at ? '· ' + relative(m.at) : ''}</div>${m.role === 'user' ? `<div class="message-body">${escapeHtml(m.text)}</div>` : `<div class="message-body md">${renderMarkdown(m.text)}</div>${fileChips(m.text)}`}</div>`).join('') : '<div class="table-empty">No messages found in this session record.</div>'}${pendingMessages(session, messages)}`, !silent);
    if (silent) { if (changed) content.scrollTop = state.pinBottom || stickToBottom ? content.scrollHeight : priorScroll; }
    else { state.pinBottom = true; content.scrollTop = content.scrollHeight; }
    $('#drawer-tabs').classList.toggle('hidden', !session.tty && !session.cwd);
    $('#drawer-tabs [data-pane=terminal]').classList.toggle('hidden', !session.tty);
    $('#drawer-tabs [data-pane=files]').classList.toggle('hidden', !session.cwd);
    if (!silent) { state.files = { key:'', list:[] }; showPane('conversation'); fetchFiles(`/api/sessions/${encodeURIComponent(session.id)}`).then(() => openSession(session.id, true)); }
    else if (!session.tty && state.pane === 'terminal') showPane('conversation');
    $('#followup-skip-wrap').classList.toggle('hidden', Boolean(session.tty));
    $('.drawer-composer').classList.remove('hidden');
    const missingGeminiProject = session.harness === 'gemini' && !session.cwd;
    const blockedByTurn = session.liveState === 'working' && !['codex', 'claude'].includes(session.harness);
    const harnessReady = state.health[session.harness]?.state === 'ready';
    const canHandOff = !['auto', 'stay', session.harness].includes($('#followup-route').value);
    $('#followup-send').disabled = (!harnessReady && !canHandOff) || missingGeminiProject || blockedByTurn;
    $('#followup-prompt').disabled = missingGeminiProject || blockedByTurn;
    $('#followup-prompt').placeholder = blockedByTurn ? 'This desktop session is working; wait for it to finish' : missingGeminiProject ? 'Original Gemini project path is unavailable' : !harnessReady ? (canHandOff ? 'Send to the handoff you selected…' : `${session.harness} is not ready; restore it or choose a handoff…`) : session.harness === 'codex' && session.liveState !== 'history' && !session.tty ? 'Queue a follow-up for this Codex session…' : session.tty ? `Message ${harnessNames[session.harness] || session.harness}…` : ['claude', 'codex'].includes(session.harness) ? `Message ${harnessNames[session.harness]} (it reopens in Terminal on the Mac)…` : 'Continue this session…';
    if (!silent) {
      openDrawer();
      // Scroll once the drawer is visible (a hidden element cannot scroll), and again after late layout such as fonts.
      const toBottom = () => { if (state.pinBottom && state.selectedSession?.id === session.id) content.scrollTop = content.scrollHeight; };
      requestAnimationFrame(toBottom); [350, 1000, 2000].forEach(ms => setTimeout(toBottom, ms)); document.fonts?.ready.then(toBottom);
    }
  } catch (error) { if (!silent) showFeedback(error.message); }
}
async function openTask(id, silent = false) {
  const known = state.taskDetail?.id === id ? state.taskDetail : null;
  try {
    const data = await api(`/api/tasks/${encodeURIComponent(id)}?v=${known?.v || ''}`);
    if (silent && state.selectedTask !== id) return;
    if (data.same && silent) return; // nothing changed since it was drawn
    state.taskDetail = data.same ? known : { id, v:data.v, task:data.task };
  } catch (error) { if (!silent) showFeedback(error.message); return; }
  renderTask(state.taskDetail.task, silent);
}
function renderTask(task, silent = false) { const id = task.id; if (state.followTask === task.id && task.sessionId && state.sessions.some(s => s.id === task.sessionId)) { state.followTask = null; state.pinBottom = true; return openSession(task.sessionId); } if (!silent) { state.files = { key:'', list:[] }; if (task.cwd) fetchFiles(`/api/tasks/${encodeURIComponent(task.id)}`).then(() => openTask(task.id, true)); } state.selectedTask = id; state.selectedSession = null; state.login = null; $('#detail-drawer').classList.remove('login-mode'); $('#drawer-harness').innerHTML = `${symbol(task.harness)} <span style="vertical-align:middle;margin-left:7px">TASK · ${escapeHtml(task.status.toUpperCase())}</span>`; const scroll = $('#drawer-content').scrollTop; const changed = setDrawerContent(`<h2 class="drawer-title">${escapeHtml(task.title)}</h2><div class="drawer-path">${escapeHtml(task.cwd)} · ${relative(task.createdAt)}</div><div class="message"><div class="message-label">ROUTING · ${escapeHtml((task.routeSource || 'local').toUpperCase())}</div><div class="message-body">${escapeHtml(task.routeReason)}${task.handoffFrom ? `\nHanded off from: ${escapeHtml(task.handoffFrom)}` : ''}${task.sessionId ? `\nSession: ${escapeHtml(task.sessionId)}` : ''}${task.waitingOn && task.status === 'running' ? `\nWaiting for your answer in its Terminal tab: ${escapeHtml(task.waitingOn)}` : ''}${task.tty ? `\nTerminal on the Mac: ${escapeHtml(task.tty.replace('/dev/', ''))}${task.permissions === 'skip' ? ' · permissions skipped' : task.permissions === 'default' ? ' · asks before using tools' : " · uses that terminal's own permissions"}` : ''}${task.routeFallbackReason ? `\n${escapeHtml(task.routeFallbackReason)}` : ''}</div></div><div class="message"><div class="message-label">MODEL · ${escapeHtml((task.modelSource || 'harness-default').toUpperCase())}</div><div class="message-body">${escapeHtml(task.model || (task.modelSource === 'session' ? 'Current session model' : 'Harness default'))} · ${escapeHtml(task.modelReason || '')}${task.modelFallbackReason ? `\n${escapeHtml(task.modelFallbackReason)}` : ''}</div></div><div class="message user"><div class="message-label">YOUR PROMPT</div><div class="message-body">${escapeHtml(task.prompt)}</div></div><div class="message"><div class="message-label">${escapeHtml(task.harness.toUpperCase())} · ${escapeHtml(task.status.toUpperCase())}</div><div class="message-body md">${task.output ? renderMarkdown(task.output) : escapeHtml(task.status === 'running' ? 'Working on it…' : 'No output yet.')}</div>${fileChips(task.output)}</div>${task.error ? `<div class="message"><div class="message-label">DETAILS</div><div class="message-body">${escapeHtml(task.error)}</div></div>` : ''}${task.delivery !== 'queue' && ['running','cancelling'].includes(task.status) ? `<button class="pill" id="cancel-task" ${task.status === 'cancelling' ? 'disabled' : ''}>Cancel task</button>` : ''}${task.sessionId ? `<button class="pill" id="open-task-session" style="margin-left:8px">Open session ↗</button>` : ''}`, !silent); if (!silent) $('#drawer-content').scrollTop = 0; else if (changed) $('#drawer-content').scrollTop = scroll; $('#drawer-tabs').classList.toggle('hidden', !task.tty); $('#drawer-tabs [data-pane=terminal]').classList.toggle('hidden', !task.tty); $('#drawer-tabs [data-pane=files]').classList.add('hidden'); if (!silent || !task.tty) showPane('conversation'); $('.drawer-composer').classList.add('hidden'); if (!silent) openDrawer(); }
$('#auth-form').addEventListener('submit', async e => { e.preventDefault(); try { const result = await api('/api/auth', { method:'POST', body:JSON.stringify({ password:$('#auth-password').value, pairCode }) }); $('#auth-error').textContent = ''; $('#auth-password').value = ''; if (result.status === 'pending') return showWaiting(result.device?.name); await init(); } catch (error) { $('#auth-error').textContent = error.message; } });
$('#show-password-setup').addEventListener('click', () => { $('#password-setup').classList.toggle('hidden'); $('#setup-password').focus(); });
$('#password-setup').addEventListener('submit', async e => { e.preventDefault(); const password = $('#setup-password').value; if (password !== $('#setup-password-confirm').value) { $('#auth-error').textContent = 'Passwords do not match.'; return; } try { await api('/api/password/setup', { method:'POST', body:JSON.stringify({ password }) }); $('#auth-error').textContent = 'Password saved. Unlocking…'; await api('/api/auth', { method:'POST', body:JSON.stringify({ password }) }); $('#password-setup').reset(); await init(); } catch (error) { $('#auth-error').textContent = error.message; } });
$('#logout-button').addEventListener('click', async () => { await api('/api/logout', { method:'POST' }); closeDrawer(); showAuth(); });
$$('.nav-item').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$('#view-live').addEventListener('click', () => { state.filter = 'live'; $$('#session-filters .pill').forEach(p => p.classList.toggle('active', p.dataset.filter === 'live')); setView('sessions'); });
$('#view-sessions').addEventListener('click', () => setView('sessions'));
$('#session-search').addEventListener('input', render);
$$('#session-filters .pill').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; $$('#session-filters .pill').forEach(p => p.classList.toggle('active', p === button)); render(); }));
$('#prompt').addEventListener('input', () => { clearTimeout(state.previewTimer); state.previewTimer = setTimeout(previewRoute, 450); });
async function openLogin(name) {
  try {
    const { tty } = await api(`/api/harnesses/${name}/login`, { method:'POST' });
    state.selectedSession = null; state.selectedTask = null; state.login = { harness:name, tty, ready:false };
    setView(state.view); // closes the phone sidebar
    $('#drawer-harness').innerHTML = `${symbol(name)} <span style="vertical-align:middle;margin-left:7px">${escapeHtml(harnessNames[name].toUpperCase())} · SIGN IN</span>`;
    $('#detail-drawer').classList.add('login-mode');
    $('#drawer-tabs').classList.add('hidden');
    $('#terminal-caption').textContent = `Signing in on the Mac (${tty.replace('/dev/', '')}). If a browser opens there, finish in it; Shed checks every few seconds.`;
    showPane('terminal'); openDrawer();
  } catch (error) { showFeedback(error.message); }
}
// While a sign-in window is shown, re-check that harness until it reports ready.
setInterval(async () => {
  const login = state.login;
  if (!login || login.ready || $('#detail-drawer').classList.contains('hidden')) return;
  try {
    const data = await api('/api/harness-health?force=1');
    state.health = data.harnesses || {}; renderHarnesses(); updateHarnessReadiness();
    if (state.login === login && state.health[login.harness]?.state === 'ready') { login.ready = true; $('#terminal-caption').textContent = `✓ ${harnessNames[login.harness]} is signed in and ready. You can close this.`; }
  } catch {}
}, 5000);
// The sidebar's + starts a session on that harness: it opens the New session composer with the harness picked.
$('#harness-list').addEventListener('click', e => {
  const login = e.target.closest('[data-login]');
  if (login) return openLogin(login.dataset.login);
  const button = e.target.closest('[data-start]');
  if (!button) return;
  setView('inbox');
  $('#harness-select').value = button.dataset.start;
  renderModelChoices(); toggleSkipPermissions(); previewRoute();
  const composer = $('#prompt').closest('.composer-card');
  composer.scrollIntoView({ behavior:'smooth', block:'center' });
  composer.classList.remove('flash'); void composer.offsetWidth; composer.classList.add('flash');
  $('#prompt').focus({ preventScroll:true });
});
function toggleSkipPermissions() { $('#skip-wrap').classList.toggle('hidden', !['auto', 'claude', 'codex'].includes($('#harness-select').value)); }
$('#harness-select').addEventListener('change', () => { renderModelChoices(); toggleSkipPermissions(); previewRoute(); }); $('#model-select').addEventListener('change', previewRoute); $('#project-select').addEventListener('change', () => { toggleNewWorkspace(); previewRoute(); }); $('#new-workspace').addEventListener('input', previewRoute);
$('#send-button').addEventListener('click', () => sendTask($('#prompt').value));
$('#prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendTask($('#prompt').value); } });
// Runs the same local Laya decision a send would, so the drawer can say where a follow-up will go before it is sent.
async function previewFollowup() {
  const box = $('#followup-preview'), session = state.selectedSession, prompt = $('#followup-prompt').value.trim();
  const handoff = session && !['auto', 'stay', session.harness].includes(followupMode());
  if (!session || !handoff || prompt.length < 9) { state.followupPreviewKey = null; box.classList.add('hidden'); return; }
  const request = { prompt, sessionId:session.id, followup:followupMode(), model:$('#followup-model').value };
  const key = JSON.stringify(request); state.followupPreviewKey = key;
  box.innerHTML = '<span class="route-symbol">✦</span><span>Checking the model for this follow-up…</span>'; box.classList.remove('hidden');
  try {
    const { route } = await api('/api/followup-preview', { method:'POST', body:JSON.stringify(request) });
    if (state.followupPreviewKey !== key) return;
    const names = {codex:'Codex',claude:'Claude Code',gemini:'Gemini',pi:'Pi',opencode:'OpenCode'}, harness = names[route.harness] || route.harness;
    const model = route.model || (route.modelSource === 'session' ? 'current session model' : 'harness default');
    const confidence = typeof route.confidence === 'number' ? ` · ${Math.round(route.confidence * 100)}% sure` : '';
    const headline = route.handoff ? `Hand off to ${harness}` : `Stay in ${harness}`;
    const where = route.handoff ? 'New session in this project, carrying the recent conversation.' : route.fallbackReason ? `${route.fallbackReason}.` : '';
    box.innerHTML = `<span class="route-symbol">✦</span><span><b>${escapeHtml(headline)}</b>${escapeHtml(confidence)}<small>${escapeHtml([where, `Model: ${route.modelReason || model}.`].filter(Boolean).join(' '))}</small></span>`;
  } catch (error) {
    if (state.followupPreviewKey === key) box.innerHTML = `<span class="route-symbol">!</span><span>${escapeHtml(error.message)}</span>`;
  }
}
$$('#drawer-tabs button').forEach(button => button.addEventListener('click', () => showPane(button.dataset.pane)));
setInterval(() => loadTerminal(), 2000);
// Typing on the terminal's own prompt line sends a tracked follow-up into that same terminal (Shift+Enter for a new line).
async function sendTerminalLine() {
  const box = $('#terminal-prompt'), target = terminalTarget(), prompt = box.value;
  if (!target || !prompt.trim() || box.disabled) return;
  box.disabled = true;
  try {
    // A session line is a tracked follow-up; a sign-in window just gets the text typed in.
    if (state.login) await api(target.url, { method:'POST', body:JSON.stringify({ text:prompt }) });
    else await api('/api/tasks', { method:'POST', body:JSON.stringify({ prompt, sessionId:state.selectedSession.id, followup:'stay', harness:'auto', model:'', newSession:false }) });
    box.value = ''; box.style.height = '';
    setTimeout(() => loadTerminal(), 900);
  } catch (error) { showFeedback(error.message); }
  finally { box.disabled = false; box.focus(); }
}
$('#terminal-line').addEventListener('submit', e => { e.preventDefault(); sendTerminalLine(); });
$('#terminal-prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendTerminalLine(); } });
$('#terminal-prompt').addEventListener('input', e => { e.target.style.height = ''; e.target.style.height = `${e.target.scrollHeight}px`; });
$('#terminal-view').addEventListener('click', () => { if (!getSelection().toString()) $('#terminal-prompt').focus(); });
// Terminal keys. AppleScript can only type text followed by Return, so each control is a key that tolerates that Return:
// Ctrl+C stops a turn, Shift+Tab switches mode, digits answer prompts. Esc is left out: Esc then Return arrives as Alt+Enter.
$('#terminal-controls').addEventListener('click', async e => {
  const button = e.target.closest('[data-key]'), target = terminalTarget();
  if (!button || !target) return;
  try { await api(target.url, { method:'POST', body:JSON.stringify({ text:button.dataset.key }) }); setTimeout(() => loadTerminal(), 600); }
  catch (error) { showFeedback(error.message); }
});
// Connecting a phone: a QR code for Shed's address (the secure tunnel when it is up, otherwise this Wi-Fi network).
async function loadConnect() {
  try {
    const data = await api('/api/connect');
    if (!data.url) {
      $('#connect-qr').innerHTML = ''; $('#connect-card').classList.add('hidden');
      $('#connect-url').textContent = ''; $('#connect-note').textContent = 'The secure link is not running right now, so a phone cannot connect. It starts automatically with the Mac; check that the Mac is online.';
      return;
    }
    $('#connect-qr').innerHTML = data.qr; $('#connect-card-qr').innerHTML = data.qr;
    $('#connect-url').textContent = data.url; $('#connect-url').href = data.url;
    $('#connect-url').textContent = data.link || data.url; $('#connect-url').href = data.url;
    $('#connect-note').textContent = data.secure ? 'This code signs your phone in as a trusted device for the next 10 minutes. The link itself still asks for your password, and other devices need your approval on this Mac.' : 'The secure link is not running, so this address only works on the same Wi-Fi as the Mac, over plain http.';
    $('#connect-card').classList.toggle('hidden', Boolean(data.phoneConnectedAt));
  } catch {}
}
function openConnect() { loadConnect(); $('#connect-dialog').showModal(); }
// The QR code's pairing code lasts 10 minutes, so a QR left on the Mac's screen is refreshed before it expires.
setInterval(() => { if (state.local && $('#auth-screen').classList.contains('hidden')) loadConnect(); }, 5 * 60 * 1000);
$('#connect-phone').addEventListener('click', openConnect);
$('#connect-card-more').addEventListener('click', openConnect);
$('#connect-close').addEventListener('click', () => $('#connect-dialog').close());
$('#connect-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
// On a phone, the command center has a message bar: type and send, and Laya picks the agent.
// The phone bar's agent picker mirrors the main composer's harness list (same readiness, "Auto" for Laya).
function syncPhoneHarness() {
  const source = $('#harness-select'), picker = $('#phone-harness'), current = picker.value || 'auto';
  setOptions(picker, [...source.options].map(o => `<option value="${escapeHtml(o.value)}"${o.disabled ? ' disabled' : ''}>${o.value === 'auto' ? '✦ Auto' : escapeHtml(o.textContent)}</option>`).join(''));
  picker.value = [...picker.options].some(o => o.value === current && !o.disabled) ? current : 'auto';
}
async function sendPhoneMessage() {
  const box = $('#phone-message-input'), text = box.value;
  if (!text.trim()) return;
  $('#harness-select').value = $('#phone-harness').value; renderModelChoices();
  if (await sendTask(text)) { box.value = ''; box.style.height = ''; }
}
$('#phone-message').addEventListener('submit', e => { e.preventDefault(); sendPhoneMessage(); });
$('#phone-message-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendPhoneMessage(); } });
$('#phone-message-input').addEventListener('input', e => { e.target.style.height = ''; e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`; });
function followupMode() { return $('#followup-route').value; }
function sendFollowup() { if (state.selectedSession) sendTask($('#followup-prompt').value, { sessionId:state.selectedSession.id, followup:followupMode() }); }
$('#followup-send').addEventListener('click', sendFollowup);
$('#followup-route').addEventListener('change', () => { $('#followup-model').value = ''; renderModelChoices(); if (state.selectedSession) openSession(state.selectedSession.id, true); previewFollowup(); });
$('#followup-model').addEventListener('change', previewFollowup);
$('#followup-prompt').addEventListener('input', () => { clearTimeout(state.followupTimer); state.followupTimer = setTimeout(previewFollowup, 700); });
const desktopKeys = matchMedia('(min-width: 701px) and (pointer: fine)');
$('#followup-prompt').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing || !state.selectedSession) return;
  if (e.metaKey || e.ctrlKey || (desktopKeys.matches && !e.shiftKey)) { e.preventDefault(); sendFollowup(); }
});
// The message box grows with its text, up to a limit.
function fitComposer() { const box = $('#followup-prompt'); box.style.height = ''; box.style.height = `${Math.min(box.scrollHeight + 2, Math.round(innerHeight * 0.35))}px`; }
$('#followup-prompt').addEventListener('input', fitComposer);
document.addEventListener('click', e => { const row = e.target.closest('[data-session]'); if (row) openSession(row.dataset.session); const task = e.target.closest('[data-task]'); if (task) openTask(task.dataset.task); if (e.target.id === 'cancel-task' && state.selectedTask) api(`/api/tasks/${state.selectedTask}/cancel`, { method:'POST' }).then(refresh).catch(err => showFeedback(err.message)); if (e.target.id === 'open-task-session') { const item = state.tasks.find(t => t.id === state.selectedTask); if (item?.sessionId) openSession(item.sessionId); } });
document.addEventListener('click', e => { if (e.target.id === 'configure-laya') setView('settings'); });
$('#test-laya').addEventListener('click', async () => { const el = $('#settings-feedback'); el.textContent = 'Testing the local Laya model…'; el.classList.remove('hidden'); try { const result = await api('/api/laya/test', {method:'POST'}); el.textContent = `${result.model} is running locally. Session and model routing are ready.`; const me = await api('/api/me'); Object.assign(state, me); renderHarnesses(); } catch (error) { el.textContent = `Local model test failed: ${error.message}`; } });
$('#start-new-session').addEventListener('click', () => { if (matchMedia('(max-width: 700px)').matches) { $('#phone-message-input').focus(); return; } $('#new-session').scrollIntoView({behavior:'smooth'}); setTimeout(() => $('#prompt').focus(), 350); });
$('#model-editor-harness').addEventListener('change', e => setEditorHarness(e.target.value));
$('#model-rows').addEventListener('input', e => { const row = e.target.closest('[data-index]'); if (!row || !e.target.dataset.field) return; const model = modelState.draft.models[Number(row.dataset.index)]; model[e.target.dataset.field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; });
$('#model-rows').addEventListener('change', e => { if (['enabled','id','label'].includes(e.target.dataset.field)) { const row = e.target.closest('[data-index]'); modelState.draft.models[Number(row.dataset.index)][e.target.dataset.field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; renderModelEditor(); } });
$('#model-rows').addEventListener('click', e => { const remove = e.target.closest('[data-remove]'); if (!remove) return; const removed = modelState.draft.models.splice(Number(remove.dataset.remove), 1)[0]; if (modelState.draft.defaultModel === removed.id) modelState.draft.defaultModel = ''; renderModelEditor(); });
$('#add-model').addEventListener('click', () => { if (modelState.draft.models.length >= 16) return; modelState.draft.models.push({id:'',label:'',description:'',enabled:true}); renderModelEditor(); $('#model-rows .model-row:last-child input[data-field="id"]')?.focus(); });
$('#default-model').addEventListener('change', e => { modelState.draft.defaultModel = e.target.value; });
$('#save-models').addEventListener('click', async () => { const el = $('#models-feedback'), harness = $('#model-editor-harness').value; try { const { config } = await api('/api/models', { method:'POST', body:JSON.stringify({ harness, ...modelState.draft }) }); modelState.configs[harness] = config; setEditorHarness(harness); renderModelChoices(); el.textContent = `Saved ${config.models.filter(model => model.enabled).length} enabled models for ${harness}. Laya will choose among them when this harness is routed.`; el.classList.remove('hidden'); } catch (error) { el.textContent = error.message; el.classList.remove('hidden'); } });
$('#close-drawer').addEventListener('click', closeDrawer); $('#drawer-backdrop').addEventListener('click', closeDrawer);
$('#menu-button').addEventListener('click', () => { $('.sidebar').classList.add('open'); $('#mobile-scrim').classList.remove('hidden'); });
$('#mobile-scrim').addEventListener('click', () => { $('.sidebar').classList.remove('open'); $('#mobile-scrim').classList.add('hidden'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); if ((e.metaKey || e.ctrlKey) && ['1','2','3'].includes(e.key)) { e.preventDefault(); setView(({1:'inbox',2:'sessions',3:'activity'})[e.key]); } });
function updateClock() { $('#clock').textContent = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
updateClock(); setInterval(updateClock, 30000); setInterval(() => { if ($('#auth-screen').classList.contains('hidden')) refresh(); }, 5000); setInterval(() => { if ($('#auth-screen').classList.contains('hidden')) refreshHarnessHealth(); }, 30000); init();
