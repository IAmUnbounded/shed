import { renderMarkdown } from './markdown.js';
const state = { sessions: [], tasks: [], comparisons: [], available: {}, health: {}, view: 'inbox', filter: 'all', selectedSession: null, selectedTask: null, selectedComparison: null, composerMode: 'single', runMode: 'build', compareHarnesses: new Set(), queueItems: [], previewTimer: null };
// Messages sent from Shed, shown in the conversation until the session's transcript records them.
state.pending = [];
state.v = {}; // last version of each polled resource
state.sessionLimit = 60;
// A 32-bit FNV-1a fingerprint: enough to tell "same HTML as last time" without storing the HTML a second time.
function fingerprint(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); } return `${h >>> 0}:${text.length}`; }
const harnessNames = { codex:'Codex', claude:'Claude Code', gemini:'Gemini', pi:'Pi', opencode:'OpenCode', antigravity:'Antigravity' };
const modelState = { configs:{}, draft:null };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const relative = date => { const diff = Math.max(0, Date.now() - Date.parse(date)); const m = Math.floor(diff / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : m < 10080 ? `${Math.floor(m / 1440)}d ago` : new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
const projectName = cwd => cwd ? cwd.split('/').filter(Boolean).pop() : 'Unknown project';
// When the Mac starts serving a newer Shed, reload, unless something is being typed (then offer a Reload button).
let loadedVersion = document.querySelector('meta[name="shed-version"]')?.content || '', updatePending = false;
// The app's files are kept on the phone by the service worker (sw.js) so it opens without waiting for the tunnel.
// When the Mac runs a newer Shed, every file is fetched fresh first, all of them, then stored together, then the page
// reloads, so a reload never mixes old and new files.
const SHELL_CACHE = 'shed-shell-v1', SHELL_FILES = ['/', '/app.js', '/markdown.js', '/styles.css', '/theme.css', '/logo.svg', '/manifest.webmanifest'];
async function reloadFresh() {
  try {
    if (window.caches) {
      const fresh = await Promise.all(SHELL_FILES.map(url => fetch(url, { cache:'no-store' })));
      if (fresh.every(r => r.ok)) { const cache = await caches.open(SHELL_CACHE); await Promise.all(fresh.map((r, i) => cache.put(SHELL_FILES[i], r))); }
    }
  } catch { /* The reload below still fetches what the cache can't give. */ }
  location.reload();
}
function noticeVersion(version) {
  if (!version) return;
  if (!loadedVersion) { loadedVersion = version; return; }
  if (version === loadedVersion || updatePending) return;
  updatePending = true;
  const typing = ['#phone-message-input', '#followup-prompt', '#prompt', '#terminal-prompt', '#phone-workspace'].some(sel => document.querySelector(sel)?.value?.trim());
  if (!typing) return reloadFresh();
  document.getElementById('update-banner')?.classList.remove('hidden');
}
document.getElementById('update-reload')?.addEventListener('click', () => reloadFresh());
// While the Mac is restarting Shed or is unreachable, requests fail fast and a small banner says so, instead of the
// page silently hanging. The banner clears on the next request that gets through.
function setOffline(offline) { document.getElementById('reconnecting')?.classList.toggle('hidden', !offline); }
async function api(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 20000);
  let res;
  try { res = await fetch(url, { credentials:'same-origin', headers:{ 'Content-Type':'application/json' }, signal:controller.signal, ...options }); }
  catch (error) { setOffline(true); throw new Error(error.name === 'AbortError' ? 'Your Mac is taking too long to answer. Try again in a moment.' : 'Cannot reach your Mac right now. Shed may be restarting.'); }
  finally { clearTimeout(timer); }
  let data;
  try { data = await res.json(); }
  catch { setOffline(res.status >= 500); throw new Error(res.status >= 500 ? 'Cannot reach your Mac right now. Shed may be restarting.' : 'Unexpected response from your Mac.'); }
  setOffline(false);
  noticeVersion(res.headers.get('X-Shed-Version'));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data });
  return data;
}
function symbol(harness) { return `<span class="harness-symbol ${escapeHtml(harness)}">${({codex:'◇',claude:'✳',gemini:'✦',pi:'π',opencode:'◎',antigravity:'▲'})[harness] || '?'}</span>`; }
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
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    $('#auth-pair-wrap')?.classList.toggle('hidden', localHost || Boolean(pairCode) || !configured);
    const device = await api('/api/auth/device');
    if (device.status === 'pending') showWaiting(device.name);
  } catch {}
}
function hideAuth() { $('#auth-screen').classList.add('hidden'); }
function setView(view) { state.view = view; if (view === 'settings') { loadRemote(true); loadShareSettings(); prepareShareLink(); loadAutoClose(); loadAutoRoute(); loadBranchSetting(); loadWorktrees(); } $('#phone-message').classList.toggle('hidden', view !== 'inbox'); $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== `view-${view}`)); $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view)); $('#page-name').textContent = ({ inbox:'Command center', sessions:'Sessions', activity:'Activity', settings:'Settings' })[view]; const url = new URL(location.href); if (view === 'inbox') url.searchParams.delete('view'); else url.searchParams.set('view', view); history.replaceState(null, '', url); document.querySelector('.sidebar').classList.remove('open'); $('#mobile-scrim').classList.add('hidden'); render(); }
function hasHarnessSessions(name) { return state.sessions.some(s => s.harness === name); }
function renderHarnesses() {
  const names = harnessNames;
  const labels = { ready:'READY', needs_auth:'SIGN IN', offline:'OFFLINE', unknown:'CHECK', checking:'CHECKING' };
  $('#harness-list').innerHTML = Object.keys(names).filter(name => state.available[name] || hasHarnessSessions(name)).map(name => {
    const viewOnly = !state.available[name];
    const health = state.health[name] || { state:'checking', detail:'Checking the CLI' };
    const label = viewOnly ? 'VIEW ONLY' : name === 'opencode' && health.state === 'needs_auth' ? 'CONNECT' : labels[health.state] || 'CHECK';
    const checked = health.checkedAt ? ` · Checked ${new Date(health.checkedAt).toLocaleTimeString()}` : '';
    return `<div class="harness-row" title="${escapeHtml(health.detail + checked)}">${symbol(name)}<span>${names[name]}</span>${!viewOnly && ['needs_auth', 'unknown'].includes(health.state) ? `<button class="health-${escapeHtml(health.state)} sign-in" data-login="${name}" title="${escapeHtml(health.detail)}: opens the sign-in on the Mac">${label}</button>` : `<small class="health-${escapeHtml(viewOnly ? 'unknown' : health.state)}">${label}</small>`}${!viewOnly && health.state === 'ready' ? `<button class="harness-start" data-start="${name}" title="Start a new ${names[name]} session" aria-label="Start a new ${names[name]} session">+</button>` : ''}</div>`;
  }).join('');
  $('#desktop-name').textContent = state.hostname || 'This desktop';
  const ready = state.laya?.ready, loading = state.laya?.state === 'loading';
  $('#router-status').innerHTML = `<span>${ready ? '✦ Laya routing ready' : loading ? '◌ Laya loading locally' : '◇ Local fallback active'}</span><button id="configure-laya">Manage ↗</button>`;
  $('#phone-url').textContent = state.phoneUrl || 'Off (set SHED_LAN=1 for plain http on local Wi-Fi)';
  const remote = $('#remote-url');
  remote.textContent = state.remoteUrl || (state.remote?.state === 'off' ? 'Remote access is off' : state.remote?.state === 'connecting' ? 'Connecting secure link…' : 'Secure link unavailable');
  remote.href = state.remoteUrl || '#';
  remote.classList.toggle('unavailable', !state.remoteUrl);
  $('#remote-copy')?.classList.toggle('hidden', !state.remoteUrl);
  if (state.remote) renderRemoteSummary(state.remote);
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
function renderHarnessAvailability() { const names = harnessNames; const installed = Object.keys(names).filter(name => state.available[name]); const select = $('#harness-select'); const current = select.value; setOptions(select, '<option value="auto">✦ Laya chooses</option>' + installed.map(name => `<option value="${name}">${names[name]}</option>`).join('')); select.value = installed.includes(current) ? current : 'auto'; const editor = $('#model-editor-harness'); setOptions(editor, installed.map(name => `<option value="${name}">${names[name]}</option>`).join('')); if (!installed.length) setOptions(editor, '<option value="">No installed harnesses</option>'); }
function updateHarnessReadiness() { const labels = { needs_auth:'sign in', offline:'offline', unknown:'check login', checking:'checking' }; const select = $('#harness-select'); for (const option of select.options) { if (option.value === 'auto') continue; const status = state.health[option.value]?.state || 'checking'; const label = `${harnessNames[option.value] || option.value}${status === 'ready' ? '' : ` · ${option.value === 'opencode' && status === 'needs_auth' ? 'connect provider' : labels[status] || 'unavailable'}`}`; if (option.disabled !== (status !== 'ready')) option.disabled = status !== 'ready'; if (option.textContent !== label) option.textContent = label; } if (select.selectedOptions[0]?.disabled) { select.value = 'auto'; renderModelChoices(); } renderComparePicker(); }
function renderHealthDetails() { const issues = Object.entries(state.health).filter(([name, status]) => (state.available[name] || hasHarnessSessions(name)) && status.state !== 'ready' && status.state !== 'checking'); if (issues.length) $('#harness-list').insertAdjacentHTML('beforeend', `<div class="harness-health-details">${issues.map(([name, status]) => `<div title="${escapeHtml(status.detail)}"><b>${escapeHtml(harnessNames[name] || name)}:</b> ${escapeHtml(status.detail)}</div>`).join('')}</div>`); }
async function refreshHarnessHealth() { try { const data = await api('/api/harness-health'); state.health = data.harnesses || {}; for (const [name, status] of Object.entries(state.health)) if (status?.checkedAt) state.available[name] = Boolean(status.installed); renderHarnesses(); renderHarnessAvailability(); updateHarnessReadiness(); syncPhoneHarness(); } catch (error) { if (error.message === 'Authentication required.') showAuth(); } }
// The phone bar's project picker mirrors the composer's: a new folder (named from the message), a named new
// workspace, or any project a session already uses.
function syncPhoneProject() {
  const source = $('#project-select'), picker = $('#phone-project'), current = picker.value;
  const html = [...source.options].map(o => `<option value="${escapeHtml(o.value)}">${o.value === '' ? '▣ New folder' : o.value === '__new__' ? '+ New workspace…' : `▣ ${escapeHtml(o.textContent)}`}</option>`).join('');
  setOptions(picker, html);
  picker.value = [...picker.options].some(o => o.value === current) ? current : '';
}
$('#phone-project').addEventListener('change', () => {
  const naming = $('#phone-project').value === '__new__';
  $('#phone-workspace').classList.toggle('hidden', !naming);
  if (naming) $('#phone-workspace').focus();
});
function renderProjects() { const select = $('#project-select'); const current = select.value; const cwds = [...new Set(state.sessions.filter(s => !s.hidden).map(s => s.cwd).filter(Boolean))].sort((a,b) => projectName(a).localeCompare(projectName(b))); setOptions(select, '<option value="">New folder from your message</option><option value="__new__">+ New workspace</option>' + cwds.map(cwd => `<option value="${escapeHtml(cwd)}">${escapeHtml(projectName(cwd))}</option>`).join('')); select.value = [...select.options].some(option => option.value === current) ? current : ''; toggleNewWorkspace();  syncPhoneProject(); }
function toggleNewWorkspace() { const val = $('#project-select').value; $('#new-workspace-row').classList.toggle('hidden', val !== '__new__'); $('#pick-issue-btn')?.classList.toggle('hidden', !val || val === '__new__'); }
function modelOptions(harness) { return (modelState.configs[harness]?.models || []).filter(model => model.enabled).map(model => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label || model.id)}</option>`).join(''); }
function renderModelChoices() {
  const select = $('#model-select'), current = select.value;
  setOptions(select, '<option value="">✦ Laya chooses</option>' + ($('#harness-select').value === 'auto' ? '' : modelOptions($('#harness-select').value)));
  select.value = [...select.options].some(option => option.value === current) ? current : '';
  if (state.selectedSession) {
    const session = state.selectedSession, names = harnessNames;
    const routeSelect = $('#followup-route'), previousRoute = routeSelect.value;
    const others = Object.keys(names).filter(name => name !== session.harness && state.available[name] && state.health[name]?.state === 'ready');
    setOptions(routeSelect, `<option value="auto">Stay in ${escapeHtml(names[session.harness] || session.harness)}</option>` + others.map(name => `<option value="${name}">Hand off to ${names[name]}</option>`).join(''));
    routeSelect.value = [...routeSelect.options].some(option => option.value === previousRoute) ? previousRoute : 'auto';
    const target = ['auto', 'stay'].includes(routeSelect.value) ? session.harness : routeSelect.value;
    const followup = $('#followup-model'), previous = followup.value;
    const openCodex = target === 'codex' && session.harness === 'codex' && session.liveState !== 'history' && !session.tty;
    const keepsModel = ['claude', 'codex', 'antigravity'].includes(target) && target === session.harness && Boolean(session.tty);
    const current = keepsModel ? `Keep session model${session.currentModel ? ` · ${session.currentModel}` : ''}` : session.currentModel ? `Laya chooses · now ${session.currentModel}` : 'Laya chooses';
    // An open Claude terminal can switch models (Shed types /model first); an open Codex terminal keeps its own.
    const liveTerminal = keepsModel && Boolean(session.tty), switchable = liveTerminal && target === 'claude';
    setOptions(followup, openCodex || liveTerminal ? `<option value="">${liveTerminal ? escapeHtml(current) : 'Current session model'}</option>${switchable ? modelOptions(target).replace(/<option value="([^"]*)">([^<]*)</g, '<option value="$1">Switch to $2<') : ''}` : `<option value="">✦ ${escapeHtml(current)}</option>` + modelOptions(target));
    followup.value = [...followup.options].some(option => option.value === previous) ? previous : '';
    followup.disabled = openCodex || (liveTerminal && !switchable);
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
// A session's permission mode, as the agent last showed or recorded it.
const PERMISSIONS = {
  skip:['SKIPS PERMISSIONS', 'Permissions skipped: acts without asking'],
  auto:['AUTO', 'Auto mode: checks risky actions itself'],
  edits:['ACCEPTS EDITS', 'Accepts edits, asks before commands'],
  plan:['PLAN', 'Plan mode: plans only, changes nothing'],
  ask:['', 'Asks before acting'],
};
// An open Claude session gets a picker: Shed presses Shift+Tab in its Terminal until Claude shows the chosen mode.
const PICKABLE = [['ask', 'Ask before acting'], ['edits', 'Accept edits, ask before commands'], ['plan', 'Plan only, change nothing'], ['auto', 'Auto: checks risky actions itself'], ['skip', 'Skip permissions: never asks']];
function permissionLine(session) {
  if (session.harness === 'claude' && session.tty) {
    const current = session.permissions || 'ask';
    const options = PICKABLE.map(([id, text]) => `<option value="${id}"${id === current ? ' selected' : ''}>${text}</option>`).join('');
    return `<label class="permission-pick ${escapeHtml(current)}">Permissions <select id="permission-select" data-session="${escapeHtml(session.id)}" aria-label="Permission mode">${options}</select></label>`;
  }
  const mode = PERMISSIONS[session.permissions];
  if (!mode || !['claude', 'codex', 'antigravity'].includes(session.harness)) return '';
  const howTo = session.tty && session.harness === 'claude' ? ' · Mode on the Terminal tab switches modes' : '';
  return `<span class="permission-line ${escapeHtml(session.permissions)}">${escapeHtml(mode[1])}${escapeHtml(howTo)}</span>`;
}
function permissionTag(session) {
  const mode = PERMISSIONS[session.permissions];
  return mode?.[0] && ['claude', 'codex', 'antigravity'].includes(session.harness) ? ` · <span class="permission-tag ${escapeHtml(session.permissions)}">${escapeHtml(mode[0])}</span>` : '';
}
function sessionRow(s) { const live = s.liveState !== 'history'; return `<button class="session-row ${live ? 'is-live' : ''}" data-session="${escapeHtml(s.id)}">${symbol(s.harness)}<div><div class="title"><span class="title-copy">${escapeHtml(s.title)}</span>${live ? `<span class="live-pill ${escapeHtml(s.liveState)}">${s.liveState === 'working' ? 'WORKING' : 'OPEN'}</span>` : ''}${s.permissions === 'skip' ? '<span class="live-pill skip" title="Permissions skipped: acts without asking">SKIPS PERMISSIONS</span>' : ''}${s.hidden ? '<span class="live-pill cleared">CLEARED</span>' : s.cleanup ? `<span class="live-pill clutter" title="Clear up clutter on the Sessions page">${escapeHtml(s.cleanup.toUpperCase())}</span>` : ''}</div><div class="sub" title="${escapeHtml(s.cwd || '')}">${escapeHtml(projectName(s.cwd))}</div></div><span class="harness-name">${escapeHtml(harnessNames[s.harness] || s.harness)}</span><span class="time">${relative(s.updatedAt)}</span><span class="arrow">↗</span></button>`; }
function taskCard(t) { return `<div class="task-card" data-task="${escapeHtml(t.id)}"><div class="task-card-top">${symbol(t.harness)}<span>${escapeHtml(harnessNames[t.harness] || t.harness)} · ${escapeHtml(t.model || 'default model')}</span><span class="badge ${escapeHtml(t.status)}" style="margin-left:auto">${escapeHtml(t.status)}</span></div><div class="task-card-title">${escapeHtml(t.title)}</div><div class="task-card-meta"><span>${escapeHtml(projectName(t.cwd))}</span><span>${relative(t.createdAt)} ↗</span></div></div>`; }
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
  antigravity: { colors:{ B:['#4f7df9', '#22c1dc'], E:'#ffffff', G:'#7dd3fc' }, rows:[
    '......BBBB......',
    '....BBBBBBBB....',
    '...BBBBBBBBBB...',
    '..BBBBEBBBEBBB..',
    '..BBBBEBBBEBBB..',
    '..BBBBBBBBBBBB..',
    '...BBBBBBBBBB...',
    '....BB....BB....',
    '................',
    '.....GG..GG.....',
    '......GGGG......'] },
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
// Sessions talking to each other (an agent ran `shed ask`, or you introduced them in the drawer).
const TALKERS = ['claude', 'codex'];
const MESSAGE_MARK = 'Message from another agent session, sent through Shed. It is the ';
const talkOpen = x => ['sending', 'waiting'].includes(x.status);
function sessionName(id) { const s = state.sessions.find(x => x.id === id); return s ? `${harnessNames[s.harness] || s.harness} · ${projectName(s.cwd)}` : 'a closed session'; }
function talkBadge(session) {
  const x = (state.exchanges || []).find(e => e.kind === 'ask' && talkOpen(e) && (e.from === session.id || e.to === session.id));
  if (!x) return '';
  const other = sessionName(x.from === session.id ? x.to : x.from);
  return `<span class="agent-talk" title="${escapeHtml(x.message)}">↔ ${x.from === session.id ? 'asking' : 'answering'} ${escapeHtml(other)}</span>`;
}
function talkRow(x, here = '') {
  const end = id => { const s = state.sessions.find(v => v.id === id); return `<span class="talk-end">${s ? symbol(s.harness) : ''}<b>${escapeHtml(s ? projectName(s.cwd) : 'closed')}</b></span>`; };
  const intro = x.kind === 'intro';
  const state_ = x.status === 'answered' ? (intro ? 'introduced' : 'answered') : x.status === 'failed' ? 'did not arrive' : intro ? 'introducing' : x.status === 'sending' ? 'sending' : 'waiting for a reply';
  const said = intro ? (x.message ? `You: ${x.message}` : 'You introduced them.') : x.message;
  const reply = !intro && x.reply ? `<div class="talk-reply">↳ ${escapeHtml(x.reply)}</div>` : x.error ? `<div class="talk-reply failed">${escapeHtml(x.error)}</div>` : '';
  const open = here ? (x.from === here ? x.to : x.from) : intro ? x.from : x.to;
  return `<button class="talk-row ${talkOpen(x) ? 'is-open' : ''}" data-session="${escapeHtml(open)}" type="button"><div class="talk-ends">${end(x.from)}<span class="talk-arrow">${intro ? '⇄' : '→'}</span>${end(x.to)}<span class="talk-state ${escapeHtml(x.status)}">${escapeHtml(state_)}</span><span class="time">${relative(x.createdAt)}</span></div><div class="talk-said">${escapeHtml(said)}</div>${reply}</button>`;
}
function renderTalk() {
  const recent = (state.exchanges || []).filter(x => talkOpen(x) || Date.now() - Date.parse(x.createdAt) < 86400000).slice(0, 5);
  const html = recent.length ? `<div class="talk-head"><h3>Between sessions</h3><p>Your agents asking each other things.</p></div>${recent.map(x => talkRow(x)).join('')}` : '';
  const print = fingerprint(html);
  const box = $('#session-talk');
  if (box.dataset.print !== print) { box.innerHTML = html; box.dataset.print = print; box.classList.toggle('hidden', !html); }
}
// A message another agent sent is shown as coming from that agent, without Shed's delivery instructions around it.
function agentMessage(text) {
  text = text.replace(/<\/?pasted_content[^>]*>/g, '').trim(); // Claude records long pastes wrapped in this tag
  if (!text.startsWith(MESSAGE_MARK)) return null;
  const match = text.slice(MESSAGE_MARK.length).match(/^(.+?):\n\n([\s\S]*?)(?:\n\nAnswer in your normal reply[\s\S]*)?$/);
  const who = match?.[1].match(/^(\S+) session working on (.+?) \(/);
  return match ? { from:who ? `${who[1]} · ${who[2]}` : match[1], text:match[2] } : null;
}
function messageHtml(m, session) {
  const relayed = m.role === 'user' ? agentMessage(m.text) : null;
  if (relayed) return `<div class="message user relayed"><div class="message-label">↔ FROM ${escapeHtml(relayed.from.toUpperCase())} ${m.at ? '· ' + relative(m.at) : ''}</div><div class="message-body">${escapeHtml(relayed.text)}</div></div>`;
  return `<div class="message ${escapeHtml(m.role)}"><div class="message-label">${m.role === 'user' ? 'YOU' : escapeHtml(session.harness.toUpperCase())} ${m.at ? '· ' + relative(m.at) : ''}</div>${m.role === 'user' ? `<div class="message-body">${escapeHtml(m.text)}</div>` : `<div class="message-body md">${renderMarkdown(m.text)}</div>${fileChips(m.text)}`}</div>`;
}
// Who a session can be introduced to: other open Claude or Codex sessions (only those two can run `shed ask`).
function talkTargets(session) {
  if (!session || session.liveState === 'history' || !TALKERS.includes(session.harness)) return [];
  return state.sessions.filter(s => s.id !== session.id && s.liveState !== 'history' && TALKERS.includes(s.harness));
}
// What this session has said to others sits above the conversation; the button to start one is in the message bar.
function sessionTalk(session) {
  const mine = (state.exchanges || []).filter(x => x.from === session.id || x.to === session.id).slice(0, 4);
  return mine.length ? `<div class="session-talk">${mine.map(x => talkRow(x, session.id)).join('')}</div>` : '';
}
function openTalk() {
  const session = state.selectedSession;
  const others = talkTargets(session);
  if (!others.length) return;
  $('#talk-lead').textContent = `From ${sessionName(session.id)}: ${session.title}`;
  $('#talk-target').innerHTML = others.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(`${sessionName(s.id)} — ${s.title.slice(0, 60)}`)}</option>`).join('');
  $('#talk-dialog').showModal();
}
function agentCard(session, index) {
  const [mood, status] = agentMoods[session.liveState] || agentMoods.open;
  return `<button class="agent ${mood}" data-session="${escapeHtml(session.id)}" style="--d:${(index * 0.83) % 4}s" aria-label="${escapeHtml(`${harnessNames[session.harness] || session.harness} in ${projectName(session.cwd) || 'a project'}: ${status}. ${session.title}`)}">
    <span class="agent-stage"><span class="agent-harness">${escapeHtml(harnessNames[session.harness] || session.harness)}</span>${agentSvg(session.harness, mood)}</span>
    <span class="agent-name">${escapeHtml(projectName(session.cwd) || 'Untitled project')}</span>
    <span class="agent-status"><i></i>${status}</span>${talkBadge(session)}
    <span class="agent-title">${escapeHtml(session.title)}</span>
  </button>`;
}
function render() {
  const shown = state.sessions.filter(s => !s.hidden);
  $('#nav-session-count').textContent = shown.length;
  const urgency = s => ({ asking:0, working:1 })[s.liveState] ?? 2;
  const live = state.sessions.filter(s => s.liveState !== 'history').sort((a,b) => urgency(a) - urgency(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  $('#active-count').textContent = live.length;
  const desk = live.length ? live.map(agentCard).join('') : `<div class="agent-empty">${agentSvg('pi', 'open')}<div><strong>No agents at their desks</strong><p>Start a session from the sidebar's + and it will show up here.</p></div></div>`;
  const deskPrint = fingerprint(desk);
  if ($('#active-sessions').dataset.print !== deskPrint) { $('#active-sessions').innerHTML = desk; $('#active-sessions').dataset.print = deskPrint; } // rebuilding every refresh would restart the animations
  renderComparisons();
  renderTalk();
  $('#recent-sessions').innerHTML = shown.filter(s => s.liveState === 'history').slice(0,6).map(sessionRow).join('') || '<div class="table-empty">No previous desktop sessions found yet.</div>';
  // The Sessions and Activity lists are long; build them only while they are on screen.
  if (state.view !== 'sessions') { if ($('#all-sessions').firstChild) $('#all-sessions').replaceChildren(); }
  else renderSessionList();
  if (state.view !== 'activity') { if ($('#activity-list').firstChild) $('#activity-list').replaceChildren(); }
  else renderActivity();
}
document.addEventListener('click', e => { if (e.target.id === 'show-more-sessions') { state.sessionLimit += 60; renderSessionList(); } });
// Sessions that only clutter the list (never answered, tests, duplicates, deleted folders) can be cleared in one go.
// Clearing hides them in Shed only; the transcripts stay with their harness, and Show cleared brings them back.
const CLUTTER_WORDS = { 'never answered':'never answered', 'test run':'tests', duplicate:'duplicates', 'folder deleted':'in deleted folders' };
function renderCleanup() {
  const clutter = state.sessions.filter(s => !s.hidden && s.cleanup), cleared = state.sessions.filter(s => s.hidden);
  const counts = Object.keys(CLUTTER_WORDS).map(reason => [reason, clutter.filter(s => s.cleanup === reason).length]).filter(([, n]) => n);
  const bar = $('#cleanup-bar');
  bar.innerHTML = state.showCleared
    ? `<span>${cleared.length} cleared session${cleared.length === 1 ? '' : 's'}. Open one to put it back.</span>${cleared.length ? '<button class="pill" type="button" data-cleanup="restore">Put all back</button>' : ''}<button class="pill" type="button" data-cleanup="back">Back to sessions</button>`
    : `${clutter.length ? `<span><b>${clutter.length} look${clutter.length === 1 ? 's' : ''} like clutter:</b> ${counts.map(([reason, n]) => `${n} ${CLUTTER_WORDS[reason]}`).join(', ')}.</span><button class="pill" type="button" data-cleanup="clear">Clear ${clutter.length}</button>` : ''}${cleared.length ? `<button class="text-action" type="button" data-cleanup="show">Show cleared (${cleared.length})</button>` : ''}`;
  bar.classList.toggle('hidden', !bar.innerHTML);
  bar.classList.toggle('link-only', !state.showCleared && !clutter.length);
}
async function hideSessions(ids, hidden) {
  await api('/api/sessions/hide', { method:'POST', body:JSON.stringify({ ids, hidden }) });
  state.v.sessions = ''; await refresh();
}
$('#cleanup-bar').addEventListener('click', async e => {
  const action = e.target.closest('[data-cleanup]')?.dataset.cleanup;
  if (!action) return;
  if (action === 'show' || action === 'back') { state.showCleared = action === 'show'; state.sessionLimit = 60; return renderSessionList(); }
  const ids = state.sessions.filter(s => action === 'clear' ? !s.hidden && s.cleanup : s.hidden).map(s => s.id);
  if (action === 'clear' && !confirm(`Clear ${ids.length} session${ids.length === 1 ? '' : 's'} from Shed? Their transcripts stay on the Mac, and Show cleared brings them back.`)) return;
  e.target.disabled = true;
  try { await hideSessions(ids, action === 'clear'); if (action === 'restore') state.showCleared = false; renderSessionList(); showFeedback(action === 'clear' ? `Cleared ${ids.length} session${ids.length === 1 ? '' : 's'}.` : `Put back ${ids.length} session${ids.length === 1 ? '' : 's'}.`); }
  catch (error) { showFeedback(error.message); e.target.disabled = false; }
});
$('#session-search').addEventListener('input', () => { state.sessionLimit = 60; });
function renderSessionList() {
  const query = $('#session-search').value.trim().toLowerCase();
  renderCleanup();
  const filtered = state.sessions.filter(s => Boolean(s.hidden) === Boolean(state.showCleared) && (state.filter === 'all' || (state.filter === 'live' ? s.liveState !== 'history' : s.harness === state.filter)) && (!query || `${s.title} ${s.lastPrompt} ${s.cwd} ${s.harness}`.toLowerCase().includes(query)))
    .sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  $('#session-results').textContent = `${filtered.length} session${filtered.length === 1 ? '' : 's'}`;
 $('#all-sessions').innerHTML = (filtered.slice(0, state.sessionLimit).map(sessionRow).join('') || '<div class="table-empty">No sessions match this search.</div>') + (filtered.length > state.sessionLimit ? `<button class="pill show-more" id="show-more-sessions" type="button">Show ${Math.min(60, filtered.length - state.sessionLimit)} more of ${filtered.length - state.sessionLimit}</button>` : '');
}
function renderActivity() {
  $('#activity-list').innerHTML = state.tasks.length ? state.tasks.map(t => `<div class="activity-item" data-task="${escapeHtml(t.id)}">${symbol(t.harness)}<div class="activity-main"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(projectName(t.cwd))} · ${escapeHtml(t.model || 'default model')} (${escapeHtml(t.modelSource || 'harness-default')}) · ${escapeHtml(t.routeSource || 'local')} route · ${relative(t.createdAt)}</small></div><span class="badge ${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></div>`).join('') : '<div class="empty-panel"><span class="empty-symbol">◷</span><div><strong>No tasks yet</strong><p>Sessions you start through Shed will appear here.</p></div></div>';
}
async function refresh() { if (document.hidden) return; try { const [s,t,c] = await Promise.all([api(`/api/sessions?v=${state.v.sessions || ''}`), api(`/api/tasks?v=${state.v.tasks || ''}`), api(`/api/comparisons?v=${state.v.comparisons || ''}`)]); let changed = false; if (!s.same) { state.sessions = s.sessions; state.v.sessions = s.v; changed = true; } if (!t.same) { state.tasks = t.tasks; state.exchanges = t.exchanges || []; state.v.tasks = t.v; changed = true; } if (!c.same) { state.comparisons = c.comparisons || []; state.v.comparisons = c.v; changed = true; } if (changed) { renderProjects(); render(); } if (state.selectedTask) openTask(state.selectedTask, true); if (state.selectedSession) openSession(state.selectedSession.id, true); if (state.selectedComparison) openComparison(state.selectedComparison, true); } catch (error) { if (error.message === 'Authentication required.') showAuth(); } }
// Live status: the Mac pushes Typing / Waiting / Needs your OK, device approvals and remote status changes as they happen.
// Tracks server heartbeats so waking a phone from sleep immediately detects a dropped stream and reconnects cleanly.
let lastEventAt = 0;
function connectEvents(force = false) {
  const stale = lastEventAt && Date.now() - lastEventAt > 45000;
  if (!force && !stale && state.events && state.events.readyState === EventSource.OPEN) return;
  if (state.events) { try { state.events.close(); } catch {} state.events = null; }
  const events = new EventSource('/api/events');
  state.events = events;
  const markAlive = () => { lastEventAt = Date.now(); setOffline(false); };
  events.onopen = markAlive;
  events.addEventListener('ping', markAlive);
  events.addEventListener('status', e => {
    markAlive();
    let changed = false;
    for (const { id, liveState } of JSON.parse(e.data)) {
      const session = state.sessions.find(s => s.id === id);
      if (session && session.liveState !== liveState) { session.liveState = liveState; changed = true; }
      if (state.selectedSession?.id === id && state.selectedSession.liveState !== liveState) openSession(id, true);
    }
    if (changed) render();
  });
  events.addEventListener('sessions', () => { markAlive(); refresh(); });
  events.addEventListener('exchanges', () => { markAlive(); refresh(); });
  events.addEventListener('comparisons', () => { markAlive(); refresh(); });
  events.addEventListener('queue', () => { markAlive(); if (state.selectedSession) loadSessionQueue(state.selectedSession.id); });
  events.addEventListener('devices', () => { markAlive(); if (state.local || state.view === 'settings') loadDevices(); });
  events.addEventListener('remote', e => {
    markAlive();
    try {
      const status = JSON.parse(e.data);
      state.remote = status; state.remoteUrl = status.url || '';
      renderHarnesses(); loadConnect(); if (state.view === 'settings') loadRemote();
    } catch {}
  });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#auth-screen').classList.contains('hidden')) { connectEvents(true); refresh(); loadTerminal(); } });
window.addEventListener('online', () => { if ($('#auth-screen').classList.contains('hidden')) { connectEvents(true); refresh(); } });
setInterval(() => { if (!document.hidden && $('#auth-screen').classList.contains('hidden') && lastEventAt && Date.now() - lastEventAt > 45000) connectEvents(true); }, 15000);
// Opening takes one request (/api/bootstrap). Before it answers, the lists last seen on this device are drawn from its
// own cache, so the app shows your sessions at once instead of a blank page while the tunnel connects.
const BOOT_CACHE = 'shed-boot';
function applyBoot(boot, fromCache = false) {
  Object.assign(state, boot.me);
  state.sessions = boot.sessions; state.tasks = boot.tasks; state.exchanges = boot.exchanges || []; state.comparisons = boot.comparisons || []; state.health = boot.harnesses || {};
  if (!fromCache) { state.v.sessions = boot.sessionsV; state.v.tasks = boot.tasksV; }
  modelState.configs = boot.models;
  hideAuth(); renderHarnesses(); renderHarnessAvailability(); updateHarnessReadiness(); syncPhoneHarness();
  renderModelChoices(); setEditorHarness($('#model-editor-harness').value); renderProjects(); render();
}
function forgetBoot() { try { localStorage.removeItem(BOOT_CACHE); } catch { /* Private mode. */ } }
async function init() {
  try { const cached = JSON.parse(localStorage.getItem(BOOT_CACHE) || 'null'); if (cached?.me) applyBoot(cached, true); } catch { /* No cache; wait for the Mac. */ }
  try {
    const boot = await api('/api/bootstrap');
    applyBoot(boot);
    try { localStorage.setItem(BOOT_CACHE, JSON.stringify(boot)); } catch { /* Full or private: the next open just waits for the Mac. */ }
    loadConnect(); setupPush(); loadDevices(); loadRemote(); connectEvents(); openFromUrl(location.href);
    $('#phone-message').classList.toggle('hidden', state.view !== 'inbox');
    const requestedView = new URL(location.href).searchParams.get('view'); if (['sessions','activity','settings'].includes(requestedView)) setView(requestedView);
  } catch (error) { if (error.message === 'Authentication required.') { forgetBoot(); showAuth(); } else showFeedback(error.message); }
}
async function previewRoute() { if (state.composerMode === 'compare') { $('#route-preview').classList.add('hidden'); return; } const prompt = $('#prompt').value.trim(); if (prompt.length < 9) { $('#route-preview').classList.add('hidden'); return; } try { const selectedProject = $('#project-select').value; const data = await api('/api/route', { method:'POST', body:JSON.stringify({prompt, harness:$('#harness-select').value, model:$('#model-select').value, cwd:selectedProject === '__new__' ? '' : selectedProject, newWorkspace:selectedProject === '__new__' ? $('#new-workspace').value : '', newSession:true}) }); if ($('#prompt').value.trim() !== prompt) return; const route = data.route; $('#route-preview').innerHTML = `<span class="route-symbol">✦</span><span><b>Local preview:</b> New ${escapeHtml(route.harness)} session · ${escapeHtml(route.reason)} · ${escapeHtml(route.model || 'harness default')} model</span>`; $('#route-preview').classList.remove('hidden'); } catch { $('#route-preview').classList.add('hidden'); } }
async function sendTask(prompt, options = {}) {
  if (!options.sessionId && !options.phone && state.composerMode === 'compare') return sendComparison(prompt);
  const attachKey = options.sessionId ? 'followup' : options.phone ? 'phone' : 'new', files = attached[attachKey]; if (files.some(f => f.status === 'uploading')) { showFeedback('Wait for the files to finish uploading.'); return false; } if (!prompt.trim() && !files.length) return; const button = options.sessionId ? $('#followup-send') : $('#send-button'); button.disabled = true; try { const selectedProject = $('#project-select').value; const isNew = !options.sessionId; if (files.some(f => f.status === 'failed')) throw new Error('Remove the files that failed to upload, then send again.'); const runMode = options.mode || (options.sessionId ? ($('#followup-mode')?.value || 'build') : state.runMode); const resp = await api('/api/tasks', { method:'POST', body:JSON.stringify({ prompt, mode:runMode, queueIfBusy:Boolean(options.sessionId), harness:options.harness || $('#harness-select').value, model:options.model ?? (options.sessionId ? $('#followup-model').value : $('#model-select').value), cwd:options.cwd ?? (selectedProject === '__new__' ? '' : selectedProject), newWorkspace:isNew && selectedProject === '__new__' ? $('#new-workspace').value : '', newSession:isNew, sessionId:options.sessionId || null, followup:options.followup || 'auto', attachments:files.map(f => f.id), skipPermissions:options.sessionId ? $('#followup-skip').checked : $('#skip-permissions').checked }) }); attached[attachKey] = []; renderAttachments(attachKey); $('#prompt').value = ''; $('#followup-prompt').value = ''; $('#followup-prompt').style.height = ''; state.followupPreviewKey = null; $('#followup-preview').classList.add('hidden'); $('#new-workspace').value = ''; $('#route-preview').classList.add('hidden');
  if (resp.queued && options.sessionId) { state.queueItems = resp.items || []; renderSessionQueue(); showFeedback('Queued — will run automatically when this turn finishes.'); return true; }
  const { task } = resp;
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
  $('#drawer-changes').classList.toggle('hidden', pane !== 'changes');
  $('.drawer-composer').classList.toggle('in-terminal', pane !== 'conversation');
  $('#detail-drawer').classList.toggle('wide', pane === 'terminal');
  if (pane === 'terminal') setTimeout(() => loadTerminal(true), 0); // after openDrawer() has made the drawer visible
  if (pane === 'files') loadFiles();
  if (pane === 'changes') loadChanges();
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
// Remote access: Tailscale private HTTPS, your own Cloudflare Named Tunnel, instant Quick Tunnel, or custom HTTPS URL.
// Only the Mac itself can change remote access settings.
const MODE_LABELS = { auto:'AUTO', tailscale:'TAILSCALE · PERMANENT', cloudflare:'CLOUDFLARE · PERMANENT', quick:'QUICK TUNNEL · TEMPORARY', custom:'CUSTOM · PERMANENT', off:'LOCAL ONLY' };
function remoteBadgeFor(status = {}) {
  if (status.state === 'off') return ['LOCAL ONLY', ''];
  if (status.state === 'connected') return [MODE_LABELS[status.mode] || (status.permanent ? 'PERMANENT' : 'TEMPORARY'), 'completed'];
  if (status.state === 'connecting') return ['CONNECTING', 'running'];
  if (status.state === 'error') return ['NEEDS ATTENTION', 'failed'];
  return ['OFFLINE', 'failed'];
}
function renderRemoteSummary(status = {}) {
  const [text, cls] = remoteBadgeFor(status);
  const badge = $('#remote-badge');
  if (badge) { badge.textContent = text; badge.className = `badge ${cls}`; }
  if ($('#remote-detail')) $('#remote-detail').textContent = status.detail || (status.url ? 'Open this secure link on your phone or another computer, then sign in with your password.' : 'No remote address is active right now.');
  if ($('#remote-note')) $('#remote-note').textContent = status.permanent ? 'Permanent HTTPS address (survives restarts). Local Wi-Fi address:' : 'Temporary link (changes if the tunnel restarts). Switch to Tailscale or your own Cloudflare tunnel below for a permanent address. Local Wi-Fi:';
}
function toggleRemoteFields() {
  const mode = $('#remote-mode').value;
  $('#remote-cf-fields').classList.toggle('hidden', mode !== 'cloudflare');
  $('#remote-custom-fields').classList.toggle('hidden', mode !== 'custom');
  $('#remote-ts-status').classList.toggle('hidden', !['auto', 'tailscale'].includes(mode));
}
async function loadRemote(fresh = false) {
  let data;
  try { data = await api(`/api/remote${fresh ? '?fresh=1' : ''}`); } catch { return; }
  state.remote = data.status; state.remoteUrl = data.status?.url || '';
  renderHarnesses();
  renderRemoteSummary(data.status);
  const ts = data.capabilities?.tailscale;
  $('#remote-ts-status').textContent = ts?.running
    ? `Tailscale ready on this Mac: ${ts.url}`
    : ts?.installed
      ? `Tailscale is installed: ${ts.detail}`
      : 'Tip: Install Tailscale (free) and sign in on your Mac & phone for a private, permanent HTTPS link with zero public exposure.';
  $('#remote-form').classList.toggle('hidden', !data.canChange);
  $('#remote-reconnect').classList.toggle('hidden', !data.canChange || ['off', 'custom'].includes(data.config?.mode));
  if (data.canChange && !$('#remote-form').contains(document.activeElement)) {
    $('#remote-mode').value = data.config.mode || 'auto';
    $('#remote-cf-host').value = data.config.cloudflare?.hostname || '';
    $('#remote-cf-token').value = '';
    $('#remote-cf-token').placeholder = data.config.cloudflare?.hasToken ? 'Saved (leave blank to keep current token)' : 'Paste token from Cloudflare Zero Trust';
    $('#remote-custom-url').value = data.config.customUrl || '';
    toggleRemoteFields();
  }
}
function remoteFeedback(message) { const el = $('#remote-feedback'); el.textContent = message; el.classList.remove('hidden'); }
$('#remote-mode').addEventListener('change', toggleRemoteFields);
$('#remote-copy').addEventListener('click', () => { if (state.remoteUrl) copyText(state.remoteUrl, 'Remote link copied.'); });
$('#remote-reconnect').addEventListener('click', async () => {
  const button = $('#remote-reconnect'); button.disabled = true;
  try {
    await api('/api/remote', { method:'POST', body:JSON.stringify({ restart:true }) });
    remoteFeedback('Reconnecting tunnel…');
    setTimeout(() => { loadRemote(true); loadConnect(); }, 3500);
  } catch (error) { remoteFeedback(error.message); }
  finally { button.disabled = false; }
});
$('#remote-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#remote-save'); button.disabled = true;
  const mode = $('#remote-mode').value;
  const payload = { mode, restart:true };
  if (mode === 'cloudflare') {
    payload.cloudflare = { hostname:$('#remote-cf-host').value.trim() };
    if ($('#remote-cf-token').value.trim()) payload.cloudflare.token = $('#remote-cf-token').value.trim();
  }
  if (mode === 'custom') payload.customUrl = $('#remote-custom-url').value.trim();
  try {
    await api('/api/remote', { method:'POST', body:JSON.stringify(payload) });
    $('#remote-cf-token').value = '';
    remoteFeedback(mode === 'off' ? 'Remote access turned off.' : mode === 'custom' ? 'Custom HTTPS address saved.' : 'Saved. Applying transport change…');
    setTimeout(() => { loadRemote(true); loadConnect(); }, 2500);
  } catch (error) { remoteFeedback(error.message); }
  finally { button.disabled = false; }
});
$('#revoke-others').addEventListener('click', async () => { try { await api('/api/devices/revoke-others', { method:'POST' }); loadDevices(); } catch (error) { showFeedback(error.message); } });
setInterval(() => { if ($('#auth-screen').classList.contains('hidden') && (state.local || state.view === 'settings')) loadDevices(); }, 5000);
// Share from iPhone: the Shortcut download, which browser's login to borrow for private posts, and the Shortcuts in use.
async function loadShareSettings() {
  try {
    const { keys, cookiesBrowser, browsers, base } = await api('/api/share/settings');
    const names = { '':'None (public posts only)', chrome:'Chrome', safari:'Safari', firefox:'Firefox', brave:'Brave', edge:'Edge', arc:'Arc', vivaldi:'Vivaldi', opera:'Opera', chromium:'Chromium' };
    setOptions($('#share-browser'), browsers.map(b => `<option value="${b}">${names[b] || b}</option>`).join(''));
    $('#share-browser').value = cookiesBrowser;
    $('#share-status').textContent = base ? `The Shortcut sends to ${base.replace(/^https?:\/\//, '')}. If that address changes, get the Shortcut again.` : 'Shed has no address your phone can reach yet, so the Shortcut cannot be made.';
    $('#share-get').disabled = !base;
    $('#share-mac').classList.toggle('hidden', !state.local || !base);
    $('#share-keys').innerHTML = keys.map(k => `<div class="device-row"><div><b>${escapeHtml(k.name)}</b><small>${k.uses ? `${k.uses} share${k.uses === 1 ? '' : 's'} · last ${relative(k.lastUsedAt)}` : 'Not used yet'} · added ${relative(k.createdAt)}</small></div><div class="device-actions"><button class="text-action" type="button" data-share-revoke="${escapeHtml(k.id)}">Turn off</button></div></div>`).join('');
  } catch {}
}
// On a phone the one-time link is fetched ahead of time, so a tap opens it at once: Safari blocks a window opened after
// waiting on the network, and the Home Screen app can't hand files to the Shortcuts app itself.
const onPhone = /iPhone|iPad|iPod/.test(navigator.userAgent);
let shareLink = null;
async function prepareShareLink() {
  if (!onPhone || state.view !== 'settings') return;
  try { const { url } = await api('/api/share/shortcut', { method:'POST' }); shareLink = { url, at:Date.now() }; } catch { shareLink = null; }
}
setInterval(() => { if (onPhone && state.view === 'settings' && !document.hidden && (!shareLink || Date.now() - shareLink.at > 4 * 60 * 1000)) prepareShareLink(); }, 20000);
$('#share-get').addEventListener('click', async () => {
  if (onPhone) {
    $('#share-phone').classList.remove('hidden');
    if (!shareLink || Date.now() - shareLink.at > 4.5 * 60 * 1000) prepareShareLink();
    return;
  }
  try {
    const { qr } = await api('/api/share/shortcut', { method:'POST' });
    $('#share-qr-code').innerHTML = qr; $('#share-qr').classList.remove('hidden'); setTimeout(() => $('#share-qr').classList.add('hidden'), 5 * 60 * 1000);
    setTimeout(loadShareSettings, 4000);
  } catch (error) { showFeedback(error.message); }
});
// Copying needs the tap itself, so the link and the hand-built key are fetched before the copy buttons are used.
async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); showFeedback(done); }
  catch { prompt('Copy this:', text); }
}
$('#share-copy-link').addEventListener('click', () => {
  if (!shareLink || Date.now() - shareLink.at > 4.5 * 60 * 1000) { showFeedback('Getting a fresh link. Tap again in a second.'); return prepareShareLink(); }
  copyText(shareLink.url, 'Link copied. Now open Safari and paste it into the address bar.');
  shareLink = null; setTimeout(prepareShareLink, 1500); setTimeout(loadShareSettings, 60000);
});
let manualKey = null;
$('.share-manual').addEventListener('toggle', async e => {
  if (!e.target.open || manualKey) return;
  try { manualKey = await api('/api/share/manual-key', { method:'POST' }); loadShareSettings(); } catch (error) { showFeedback(error.message); }
});
$('#share-copy-url').addEventListener('click', () => manualKey ? copyText(manualKey.url, 'Address copied. Paste it into Get Contents of URL.') : showFeedback('One moment, getting your key…'));
$('#share-copy-key').addEventListener('click', () => manualKey ? copyText(manualKey.header, 'Key copied. Paste it as the Authorization value.') : showFeedback('One moment, getting your key…'));
$('#followup-permissions').addEventListener('change', async e => {
  const select = e.target.closest('#permission-select');
  if (!select) return;
  const url = `/api/sessions/${encodeURIComponent(select.dataset.session)}/permissions`, target = select.value;
  const done = mode => showFeedback(`Now: ${PICKABLE.find(([id]) => id === mode)?.[1] || mode}.`);
  if (target === 'skip' && !confirm('Skip permissions? Claude will edit files, run commands and use the web on this Mac without asking.')) { $('#followup-permissions').dataset.line = ''; if (state.selectedSession) openSession(state.selectedSession.id, true); return; }
  select.disabled = true; showFeedback('Switching Claude\'s mode in its Terminal…');
  try { done((await api(url, { method:'POST', body:JSON.stringify({ mode:target }), timeout:60000 })).mode); }
  catch (error) {
    // Started without the option to skip: Claude is restarted in the same tab with skip on, and the conversation carries on.
    if (error.data?.restart && confirm('This session was started without the option to skip permissions. Restart Claude in its Terminal with permissions skipped? The conversation carries on where it left off.')) {
      showFeedback('Restarting Claude with permissions skipped…');
      try { done((await api(url, { method:'POST', body:JSON.stringify({ mode:'skip', restart:true }), timeout:60000 })).mode); } catch (again) { showFeedback(again.message); }
    } else showFeedback(error.message);
  }
  select.disabled = false; select.blur(); $('#followup-permissions').dataset.line = '';
  if (state.selectedSession) openSession(state.selectedSession.id, true);
});
$('#share-mac').addEventListener('click', async () => {
  try { await api('/api/share/install-on-mac', { method:'POST' }); showFeedback('Check the Mac: click Add Shortcut. It shows up on your iPhone within a minute.'); setTimeout(loadShareSettings, 3000); }
  catch (error) { showFeedback(error.message); }
});
$('#share-browser').addEventListener('change', async e => { try { await api('/api/share/settings', { method:'POST', body:JSON.stringify({ cookiesBrowser:e.target.value }) }); showFeedback(e.target.value ? 'Shed will use that browser\'s login for posts that need one. macOS may ask you to allow it once.' : 'Shed will only fetch public posts.'); } catch (error) { showFeedback(error.message); } });
$('#share-keys').addEventListener('click', async e => { const b = e.target.closest('[data-share-revoke]'); if (!b) return; try { await api(`/api/share/keys/${encodeURIComponent(b.dataset.shareRevoke)}`, { method:'DELETE' }); loadShareSettings(); } catch (error) { showFeedback(error.message); } });
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
async function loadAutoClose() { try { const { prefs } = await api('/api/autoclose'); $('#autoclose-enabled').checked = prefs.enabled; } catch { /* Settings still work without it. */ } }
$('#autoclose-enabled').addEventListener('change', () => api('/api/autoclose', { method:'POST', body:JSON.stringify({ enabled:$('#autoclose-enabled').checked }) }).catch(error => showFeedback(error.message)));
const HARNESS_NAMES = harnessNames;
async function loadAutoRoute() {
  try {
    const { prefs } = await api('/api/autoroute');
    const list = $('#autoroute-list'); list.replaceChildren();
    for (const [name, title] of Object.entries(HARNESS_NAMES)) {
      const label = document.createElement('label'), box = document.createElement('input');
      box.type = 'checkbox'; box.value = name; box.checked = !prefs.off.includes(name);
      label.append(box, ` ${title}`); list.append(label);
    }
  } catch { /* Settings still work without it. */ }
}
$('#autoroute-list').addEventListener('change', () => api('/api/autoroute', { method:'POST', body:JSON.stringify({ off:$$('#autoroute-list input').filter(box => !box.checked).map(box => box.value) }) }).catch(error => showFeedback(error.message)));
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
  try { const data = await api(`${base}/files`); state.files = { key:base, list:data.files || [], root:data.root, total:data.total || 0 }; }
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
const FILES_SHOWN = 60;
async function loadFiles() {
  const session = state.selectedSession, box = $('#drawer-files');
  if (!session) return;
  const base = `/api/sessions/${encodeURIComponent(session.id)}`;
  box.innerHTML = '<div class="files-empty">Looking for files in this project…</div>';
  const { list, root, total } = await fetchFiles(base);
  if (state.selectedSession?.id !== session.id) return;
  state.filesView = { all:false, query:'' };
  if (!list.length) { box.innerHTML = '<div class="files-empty">No videos, images, PDFs or other shareable files in this project yet.</div>'; return; }
  box.innerHTML = `<div class="files-head">${list.length} file${list.length === 1 ? '' : 's'} in <b>${escapeHtml(root || projectName(session.cwd))}</b>, newest first${total > list.length ? ` (the ${list.length} newest of ${total})` : ''}</div>${list.length > FILES_SHOWN ? '<input class="files-filter" id="files-filter" type="search" placeholder="Find a file by name or folder…" autocomplete="off">' : ''}<div id="files-list"></div>`;
  renderFileRows();
}
// Draws the rows: the newest few until asked for all, or every file whose path matches the filter.
function renderFileRows() {
  const { key:base, list } = state.files, { all, query } = state.filesView, q = query.trim().toLowerCase();
  const matches = list.map((f, i) => [f, i]).filter(([f]) => !q || f.path.toLowerCase().includes(q));
  const shown = all || q ? matches : matches.slice(0, FILES_SHOWN);
  $('#files-list').innerHTML = (shown.length ? shown.map(([f, i]) => `<div class="file-row" data-file-index="${i}"><button class="file-main" type="button" data-preview="${i}"><span class="file-icon ${escapeHtml(f.kind)}">${fileIcon(f.kind)}</span><span class="file-name"><b>${escapeHtml(f.path.split('/').pop())}</b><small>${escapeHtml(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) + ' · ' : '')}${fileSize(f.size)} · ${relative(f.modifiedAt)}</small></span></button><a class="file-download" href="${fileUrl(base, f.path, true)}" download aria-label="Download ${escapeHtml(f.path)}">Download</a><div class="file-preview hidden"></div></div>`).join('') : '<div class="files-empty">No file matches that.</div>')
    + (shown.length < matches.length ? `<button class="pill files-more" type="button" id="files-show-all">Show all ${matches.length} files</button>` : '');
}
$('#drawer-files').addEventListener('input', e => { if (e.target.id === 'files-filter') { state.filesView.query = e.target.value; renderFileRows(); } });
$('#drawer-files').addEventListener('click', e => {
  if (e.target.closest('#files-show-all')) { state.filesView.all = true; return renderFileRows(); }
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
// Changes: what the session's agent changed in its project, as git sees it. Supports Uncommitted vs Whole branch diffs,
// hidden Git checkpoints with one-tap rewind, batched inline review notes, per-file discard, quick project scripts,
// cross-harness review, local merge, and commit / push / ship PR.
state.changes = { id:'', v:'', scope:'uncommitted', data:null, open:new Set(), diffs:new Map(), notes:[], activeLine:null, checkpoints:[], cpDiff:null, scripts:[], scriptRuns:{}, activeScriptId:'', runningScriptId:'' };
const changesBase = () => `/api/sessions/${encodeURIComponent(state.selectedSession.id)}`;
function formatBatchedNotes(notes) {
  const byFile = new Map();
  for (const n of notes) byFile.set(n.file, [...(byFile.get(n.file) || []), n]);
  const sections = [...byFile.entries()].map(([file, items]) => `### \`${file}\`\n` + items.map(n => `- **Line ${n.line}**${n.code ? ` (\`${n.code.slice(0, 80)}\`)` : ''}: ${n.comment}`).join('\n'));
  return `Please address these code review notes (${notes.length}):\n\n${sections.join('\n\n')}`;
}
async function loadCheckpoints() {
  const session = state.selectedSession, c = state.changes;
  if (!session?.cwd) return;
  try {
    const data = await api(`${changesBase()}/checkpoints`);
    if (state.selectedSession?.id !== session.id) return;
    c.checkpoints = data.checkpoints || [];
    if (state.pane === 'changes') renderChanges();
  } catch { /* checkpoints are extra */ }
}
async function loadScripts() {
  const session = state.selectedSession, c = state.changes;
  if (!session?.cwd) return;
  try {
    const data = await api(`${changesBase()}/scripts`);
    if (state.selectedSession?.id !== session.id) return;
    c.scripts = data.scripts || [];
    c.scriptRuns = data.runs || {};
    if (state.pane === 'changes') renderChanges();
  } catch { /* scripts are extra */ }
}
async function loadChanges(quiet = false) {
  const session = state.selectedSession, box = $('#drawer-changes');
  if (!session?.cwd) return;
  const c = state.changes;
  if (!c.data && !quiet) box.innerHTML = '<div class="files-empty">Reading git…</div>';
  try {
    const scopeParam = c.scope === 'branch' ? 'scope=branch&' : '';
    const data = await api(`${changesBase()}/changes?${scopeParam}v=${c.v}`);
    if (state.selectedSession?.id !== session.id) return;
    if (!data.same) { c.v = data.v; c.data = data; for (const file of c.diffs.keys()) c.diffs.delete(file); }
    const count = c.data.repo ? c.data.files.length : 0;
    $('#changes-count').textContent = count; $('#changes-count').classList.toggle('hidden', !count);
    if (state.pane === 'changes' && (!data.same || !box.dataset.drawn)) { renderChanges(); for (const file of c.open) loadDiff(file); }
    if (state.pane === 'changes' && c.data.repo && (!c.pr || Date.now() - c.pr.at > 20000)) loadPr();
    if (state.pane === 'changes' && !quiet) { loadCheckpoints(); loadScripts(); }
  } catch (error) { if (!quiet) box.innerHTML = `<div class="files-empty">${escapeHtml(error.message)}</div>`; }
}
async function loadPr(fresh = false) {
  const c = state.changes, id = c.id;
  c.pr = { at:Date.now(), value:c.pr?.value };
  try { const { pr } = await api(`${changesBase()}/pr${fresh ? '?fresh=1' : ''}`); if (state.changes.id === id) { c.pr.value = pr; renderPr(); } } catch { /* PR status is extra. */ }
}
function renderPr() {
  const line = $('#pr-line'), pr = state.changes.pr?.value;
  if (!line) return;
  if (!pr) { line.innerHTML = ''; return; }
  if (pr.error) { line.innerHTML = `<span class="pr-note">${escapeHtml(pr.error)}</span>`; return; }
  const ck = pr.checks, failed = ck.failed.length;
  const checks = ck.total ? `<span class="pr-checks">${ck.passed ? `<i class="ok">✓ ${ck.passed}</i>` : ''}${failed ? `<i class="bad">✗ ${failed}</i>` : ''}${ck.pending ? `<i class="wait">◷ ${ck.pending}</i>` : ''}</span>` : '';
  line.innerHTML = `<a class="pr-chip ${escapeHtml(pr.state.toLowerCase())}" href="${escapeHtml(pr.url)}" target="_blank" rel="noopener">#${pr.number} ${pr.draft ? 'Draft' : escapeHtml(pr.state[0] + pr.state.slice(1).toLowerCase())} ↗</a>${checks}${failed ? '<button class="text-action" type="button" id="fix-checks">Fix failing checks</button>' : ''}`;
}
const commitSubject = session => { const line = topicLine(session.title || '').replace(/…$/, ''); return (line[0] || '').toUpperCase() + line.slice(1, 72); };
function reviewOptionsFor(session) {
  const ready = Object.keys(harnessNames).filter(h => state.available[h] && state.health[h]?.state === 'ready');
  const others = ready.filter(h => h !== session?.harness);
  return others.length ? others : ready;
}
function renderChanges() {
  const c = state.changes, d = c.data, box = $('#drawer-changes'), session = state.selectedSession;
  box.dataset.drawn = '1';
  if (d.removed) { box.innerHTML = '<div class="files-empty">This worktree was removed.</div>'; return; }
  if (!d.repo) { box.innerHTML = '<div class="files-empty">This project is not a git repository, so there are no changes to review.</div>'; return; }
  const message = $('#commit-message')?.value ?? commitSubject(session);
  const where = d.branch ? `<span class="branch">⎇ ${escapeHtml(d.branch)}</span>` : '<span class="branch">detached checkout</span>';
  const wtBadge = d.worktree ? '<span class="wt-badge" title="Isolated Shed branch worktree">WORKTREE</span>' : '';
  const sync = d.upstream ? `${d.ahead ? `<span>↑${d.ahead}</span>` : ''}${d.behind ? `<span>↓${d.behind}</span>` : ''}${!d.ahead && !d.behind ? '<span>up to date</span>' : ''}` : d.branch ? '<span>not pushed yet</span>' : '';
  const reviewers = reviewOptionsFor(session);
  const prevReviewer = $('#review-harness')?.value;
  const reviewBar = reviewers.length && (d.files.length || d.worktree || d.ahead)
    ? `<div class="review-bar"><select id="review-harness" aria-label="Reviewer harness">${reviewers.map(h => `<option value="${h}"${h === prevReviewer ? ' selected' : ''}>${escapeHtml(harnessNames[h] || h)}</option>`).join('')}</select><button class="pill" type="button" id="start-review" title="Start another agent on this checkout to review the diff">Review diff ↗</button></div>`
    : '';
  const scopeTabs = `<div class="changes-scopes"><div class="scope-tabs" role="tablist"><button type="button" class="${c.scope === 'uncommitted' ? 'active' : ''}" data-diff-scope="uncommitted">Uncommitted</button><button type="button" class="${c.scope === 'branch' ? 'active' : ''}" data-diff-scope="branch">Whole branch${d.scope === 'branch' && d.commitsAhead ? ` (${d.commitsAhead})` : ''}</button><button type="button" class="${c.scope === 'checkpoints' ? 'active' : ''}" data-diff-scope="checkpoints">Checkpoints${c.checkpoints.length ? ` (${c.checkpoints.length})` : ''}</button></div></div>`;
  const scriptsBar = c.scripts.length
    ? `<div class="scripts-bar"><span class="scripts-label">Run</span>${c.scripts.slice(0, 8).map(s => {
        const run = c.scriptRuns[s.id];
        const busy = c.runningScriptId === s.id;
        const cls = busy ? '' : run ? (run.ok ? ' ok' : ' fail') : '';
        const icon = busy ? '◌' : run ? (run.ok ? '✓' : '✗') : '▶';
        return `<button type="button" class="script-chip${cls}" data-run-script="${escapeHtml(s.id)}" title="${escapeHtml(s.command)}"${busy ? ' disabled' : ''}>${icon} ${escapeHtml(s.name)}</button>`;
      }).join('')}</div>`
    : '';
  const activeRun = c.activeScriptId ? c.scriptRuns[c.activeScriptId] : null;
  const scriptOutput = activeRun
    ? `<div class="script-output"><div class="script-output-head"><b>${escapeHtml(activeRun.name)}</b><span>${activeRun.ok ? 'Passed' : `Failed (exit ${activeRun.code})`} · ${(activeRun.durationMs / 1000).toFixed(1)}s</span>${!activeRun.ok ? `<button type="button" class="send-button" id="send-script-fail">Send failure to agent ↗</button>` : ''}<button type="button" class="text-action" id="close-script-output">Hide</button></div><pre>${escapeHtml(activeRun.output || '(no output)')}</pre></div>`
    : '';
  if (c.scope === 'checkpoints') {
    const cpRows = c.checkpoints.length
      ? c.checkpoints.map(cp => `<div class="cp-row"><div><b>${escapeHtml(cp.label)}</b><small>${escapeHtml(cp.kind)} · ${escapeHtml(cp.commit.slice(0, 7))} · ${relative(cp.createdAt)}</small></div><div class="cp-actions"><button type="button" class="pill" data-cp-diff="${escapeHtml(cp.id)}">Diff vs now</button><button type="button" class="pill danger" data-cp-revert="${escapeHtml(cp.id)}" data-cp-label="${escapeHtml(cp.label)}">Rewind ↺</button></div></div>`).join('')
      : '<div class="files-empty">No checkpoints yet. Shed saves a hidden Git checkpoint automatically before and after each Build turn, or tap Save checkpoint now.</div>';
    const cpDiffHtml = c.cpDiff
      ? `<div class="cp-diff-panel"><div class="cp-head"><b>Changed since "${escapeHtml(c.cpDiff.label)}"</b><button type="button" class="text-action" id="close-cp-diff">Close</button></div>${c.cpDiff.files.length ? `<div class="changes-summary">${c.cpDiff.files.length} file${c.cpDiff.files.length === 1 ? '' : 's'} <i class="add">+${c.cpDiff.additions}</i> <i class="del">−${c.cpDiff.deletions}</i></div><ul class="compare-card-files">${c.cpDiff.files.map(f => `<li>${escapeHtml(f.status)} ${escapeHtml(f.path)} (+${f.additions} −${f.deletions})</li>`).join('')}</ul>` : '<div class="diff-note">Workspace matches this checkpoint right now.</div>'}</div>`
      : '';
    box.innerHTML = `<div class="changes-head"><div class="branch-line">${where}${wtBadge}${sync}</div><div class="pr-line" id="pr-line"></div>${reviewBar}</div>${scopeTabs}${scriptsBar}${scriptOutput}
      <div class="cp-head"><span class="settings-note">Hidden Git snapshots (never touch git log or stash). Rewinding saves a backup first.</span><button type="button" class="pill" id="save-checkpoint">+ Save checkpoint</button></div>
      ${cpDiffHtml}<div class="cp-list">${cpRows}</div>`;
    renderPr();
    return;
  }
  const queueBar = c.notes.length
    ? `<div class="review-queue" id="review-queue"><span><b>${c.notes.length}</b> review note${c.notes.length === 1 ? '' : 's'} queued across ${new Set(c.notes.map(n => n.file)).size} file${new Set(c.notes.map(n => n.file)).size === 1 ? '' : 's'}</span><button class="send-button" type="button" id="send-review-notes">Send ${c.notes.length} note${c.notes.length === 1 ? '' : 's'} ↗</button><button class="text-action" type="button" id="clear-review-notes">Clear</button></div>`
    : '';
  const rows = d.files.map(f => {
    const slash = f.path.lastIndexOf('/'), name = f.path.slice(slash + 1), dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
    const open = c.open.has(f.path);
    const fileNotes = c.notes.filter(n => n.file === f.path).length;
    return `<div class="change-row${open ? ' open' : ''}" data-path="${escapeHtml(f.path)}"><div class="change-row-head"><button class="change-main" type="button"><span class="change-status s-${f.status === '?' ? 'new' : f.status}">${f.status === '?' ? 'N' : f.status}</span><span class="change-name"><b>${escapeHtml(name)}${fileNotes ? ` <span class="tab-count">${fileNotes}</span>` : ''}</b><small>${escapeHtml(f.oldPath ? `from ${f.oldPath}` : dir)}</small></span><span class="change-stat">${f.binary ? '<i>binary</i>' : `${f.additions ? `<i class="add">+${f.additions}</i>` : ''}${f.deletions ? `<i class="del">−${f.deletions}</i>` : ''}`}</span></button>${c.scope === 'uncommitted' ? `<button class="change-discard" type="button" data-discard-file="${escapeHtml(f.path)}" title="Discard changes to ${escapeHtml(f.path)}" aria-label="Discard ${escapeHtml(f.path)}">↺</button>` : ''}</div><div class="change-diff${open ? '' : ' hidden'}">${open ? diffHtml(f.path) : ''}</div></div>`;
  }).join('');
  const nothing = !d.files.length;
  const scopeNote = c.scope === 'branch' && d.baseBranch ? ` vs ${escapeHtml(d.baseBranch)}` : '';
  const secondary = d.worktree
    ? `<div class="ship-secondary">${nothing ? '<button type="button" class="pill" data-git="merge" title="Merge this clean branch into the main repository locally">Merge locally</button>' : ''}<button type="button" class="pill danger" data-git="remove-worktree" title="Remove this Shed worktree from disk">Remove worktree</button></div>`
    : '';
  box.innerHTML = `<div class="changes-head"><div class="branch-line">${where}${wtBadge}${sync}</div><div class="pr-line" id="pr-line"></div>${reviewBar}</div>${scopeTabs}${scriptsBar}${scriptOutput}${queueBar}
    ${nothing ? `<div class="files-empty">No ${c.scope === 'branch' ? `changes vs ${escapeHtml(d.baseBranch || 'base branch')}` : 'uncommitted changes'}.${d.head ? ` Last commit: <b>${escapeHtml(d.head.subject)}</b>.` : ''}</div>` : `<div class="changes-summary">${d.files.length} file${d.files.length === 1 ? '' : 's'} changed${scopeNote}${d.more ? ` (and ${d.more} more)` : ''} <i class="add">+${d.additions}</i> <i class="del">−${d.deletions}</i><button class="text-action" type="button" id="send-back">Send back with a note</button></div><div class="change-list">${rows}</div>`}
    <form class="ship-box" id="ship-box">${nothing || c.scope === 'branch' ? '' : `<input id="commit-message" maxlength="200" autocomplete="off" aria-label="Commit message" placeholder="Commit message" value="${escapeHtml(message)}">`}
      <div class="ship-actions">${nothing || c.scope === 'branch' ? '' : '<button type="button" class="pill" data-git="commit" title="Commit on this Mac only">Commit</button>'}${d.branch && (!nothing || d.ahead || !d.upstream) ? `<button type="button" class="pill" data-git="push" title="${nothing || c.scope === 'branch' ? 'Push this branch' : 'Commit, then push this branch'}">Push</button>` : ''}${nothing || c.scope === 'branch' ? '' : '<label class="draft-pr" title="Run git pre-commit hooks instead of skipping them"><input type="checkbox" id="git-verify"> Hooks</label>'}${d.branch ? `<label class="draft-pr" title="Open the pull request as a draft"><input type="checkbox" id="pr-draft"> Draft</label><button type="button" class="send-button" data-git="ship" title="${nothing || c.scope === 'branch' ? 'Push and open a pull request' : 'Commit, push and open a pull request'}">${nothing || c.scope === 'branch' ? 'Open PR ↗' : 'Ship PR ↗'}</button>` : ''}</div>${secondary}</form>`;
  renderPr();
}
function diffHtml(file) {
  const c = state.changes, diff = c.diffs.get(file);
  if (!diff) return '<div class="diff-note">Loading the diff…</div>';
  if (diff.error) return `<div class="diff-note">${escapeHtml(diff.error)}</div>`;
  if (diff.binary) return '<div class="diff-note">Binary file: no text diff.</div>';
  if (!diff.hunks.length) return '<div class="diff-note">No line changes (only the file mode or name changed).</div>';
  const active = c.activeLine?.file === file ? c.activeLine : null;
  return `<div class="diff">${diff.hunks.map(h => `<div class="hunk-head">${escapeHtml(h.context || h.header)}</div>${h.lines.map(l => {
    const ln = String(l.n ?? l.o ?? '');
    const saved = ln ? c.notes.filter(n => n.file === file && String(n.line) === ln) : [];
    const editing = active && String(active.line) === ln;
    const savedHtml = saved.map(n => `<div class="line-note-saved"><span>💬 ${escapeHtml(n.comment)}</span><button type="button" data-remove-note="${escapeHtml(n.id)}" aria-label="Remove note">×</button></div>`).join('');
    const editHtml = editing ? `<div class="line-note-box"><textarea id="inline-note-input" rows="2" placeholder="Comment on ${escapeHtml(file)}:${escapeHtml(ln)}…"></textarea><div class="line-note-actions"><button type="button" class="send-button" data-note-action="queue">Queue note</button><button type="button" class="pill" data-note-action="send-now">Send now</button><button type="button" class="text-action" data-note-action="cancel">Cancel</button></div></div>` : '';
    return `<div class="dl ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '\\' ? 'meta' : ''}${saved.length ? ' noted' : ''}" data-line="${ln}"><span class="ln">${l.t === '-' ? l.o : l.n ?? ''}</span><code>${escapeHtml(l.text) || ' '}</code></div>${savedHtml}${editHtml}`;
  }).join('')}`).join('')}${diff.truncated ? '<div class="diff-note">The diff is too long to show in full here.</div>' : ''}</div>`;
}
async function loadDiff(file) {
  const c = state.changes, id = c.id;
  if (c.diffs.has(file)) return;
  const scopeParam = c.scope === 'branch' ? '&scope=branch' : '';
  try { c.diffs.set(file, await api(`${changesBase()}/diff?path=${encodeURIComponent(file)}${scopeParam}`)); }
  catch (error) { c.diffs.set(file, { error:error.message }); }
  if (state.changes.id !== id) return;
  const row = [...$$('#drawer-changes .change-row')].find(r => r.dataset.path === file);
  if (row) row.querySelector('.change-diff').innerHTML = diffHtml(file);
}
function redrawFileDiff(file) {
  const row = [...$$('#drawer-changes .change-row')].find(r => r.dataset.path === file);
  if (row) row.querySelector('.change-diff').innerHTML = diffHtml(file);
}
// Puts a message in the session's box (on the Conversation tab) ready to send, so nothing goes without a look.
function draftFollowup(text) {
  showPane('conversation');
  const box = $('#followup-prompt');
  box.value = box.value.trim() ? `${box.value.trim()}\n\n${text}` : text;
  box.focus(); box.setSelectionRange(box.value.length, box.value.length);
  box.dispatchEvent(new Event('input'));
}
$('#drawer-changes').addEventListener('click', async e => {
  const c = state.changes;
  const scopeBtn = e.target.closest('[data-diff-scope]');
  if (scopeBtn) {
    const next = scopeBtn.dataset.diffScope;
    if (next === c.scope) return;
    c.scope = next; c.v = ''; c.open.clear(); c.diffs.clear(); c.activeLine = null; c.cpDiff = null;
    if (next === 'checkpoints') { renderChanges(); loadCheckpoints(); }
    else loadChanges();
    return;
  }
  const runScriptBtn = e.target.closest('[data-run-script]');
  if (runScriptBtn) {
    const id = runScriptBtn.dataset.runScript;
    c.runningScriptId = id; c.activeScriptId = id; renderChanges();
    try {
      const { result, runs } = await api(`${changesBase()}/scripts/run`, { method:'POST', body:JSON.stringify({ id }), timeout:100000 });
      c.scriptRuns = runs || { ...c.scriptRuns, [id]:result };
      c.runningScriptId = ''; c.activeScriptId = id; renderChanges();
      showFeedback(result.ok ? `${result.name} passed (${(result.durationMs / 1000).toFixed(1)}s).` : `${result.name} failed (exit ${result.code}).`);
    } catch (error) { c.runningScriptId = ''; renderChanges(); showFeedback(error.message); }
    return;
  }
  if (e.target.closest('#close-script-output')) { c.activeScriptId = ''; renderChanges(); return; }
  if (e.target.closest('#send-script-fail')) {
    const run = c.scriptRuns[c.activeScriptId];
    if (run) draftFollowup(`Running \`${run.name}\` (\`${run.command}\`) failed with exit code ${run.code}. Fix the cause and re-run it:\n\n\`\`\`\n${run.output.slice(-6000)}\n\`\`\``);
    return;
  }
  if (e.target.closest('#save-checkpoint')) {
    const label = prompt('Checkpoint label (optional):', 'Manual checkpoint');
    if (label === null) return;
    try {
      const data = await api(`${changesBase()}/checkpoints`, { method:'POST', body:JSON.stringify({ label }) });
      c.checkpoints = data.checkpoints || c.checkpoints;
      renderChanges(); showFeedback('Checkpoint saved.');
    } catch (error) { showFeedback(error.message); }
    return;
  }
  const cpDiffBtn = e.target.closest('[data-cp-diff]');
  if (cpDiffBtn) {
    const cp = c.checkpoints.find(x => x.id === cpDiffBtn.dataset.cpDiff);
    if (!cp) return;
    cpDiffBtn.disabled = true;
    try {
      const diff = await api(`${changesBase()}/checkpoints/${encodeURIComponent(cp.id)}/changes`);
      c.cpDiff = { ...diff, id:cp.id, label:cp.label };
      renderChanges();
    } catch (error) { showFeedback(error.message); cpDiffBtn.disabled = false; }
    return;
  }
  if (e.target.closest('#close-cp-diff')) { c.cpDiff = null; renderChanges(); return; }
  const cpRevertBtn = e.target.closest('[data-cp-revert]');
  if (cpRevertBtn) {
    const cpId = cpRevertBtn.dataset.cpRevert, label = cpRevertBtn.dataset.cpLabel || cpId;
    if (!confirm(`Rewind workspace files back to "${label}"? Shed saves a backup checkpoint first so you can undo.`)) return;
    cpRevertBtn.disabled = true;
    try {
      const res = await api(`${changesBase()}/checkpoints/${encodeURIComponent(cpId)}/revert`, { method:'POST', timeout:60000 });
      c.data = res.changes; c.checkpoints = res.checkpoints || c.checkpoints; c.v = ''; c.diffs.clear(); c.open.clear(); c.cpDiff = null;
      c.scope = 'uncommitted'; renderChanges();
      showFeedback(`Rewound files to "${label}". Backup saved.`);
    } catch (error) { showFeedback(error.message); cpRevertBtn.disabled = false; }
    return;
  }
  const discardBtn = e.target.closest('[data-discard-file]');
  if (discardBtn) {
    const file = discardBtn.dataset.discardFile;
    if (!confirm(`Discard all uncommitted changes to "${file}"? This cannot be undone.`)) return;
    discardBtn.disabled = true;
    try {
      const result = await api(`${changesBase()}/git`, { method:'POST', body:JSON.stringify({ action:'discard', file }) });
      c.data = result.changes; c.v = ''; c.diffs.delete(file); c.open.delete(file);
      c.notes = c.notes.filter(n => n.file !== file);
      if (c.activeLine?.file === file) c.activeLine = null;
      renderChanges(); showFeedback(`Discarded changes to ${file}.`);
    } catch (error) { showFeedback(error.message); discardBtn.disabled = false; }
    return;
  }
  const removeNote = e.target.closest('[data-remove-note]');
  if (removeNote) {
    const id = removeNote.dataset.removeNote;
    c.notes = c.notes.filter(n => n.id !== id);
    renderChanges();
    return;
  }
  const noteAction = e.target.closest('[data-note-action]')?.dataset.noteAction;
  if (noteAction) {
    const active = c.activeLine;
    if (noteAction === 'cancel') { c.activeLine = null; if (active) redrawFileDiff(active.file); return; }
    const text = $('#inline-note-input')?.value.trim() || '';
    if (!active) return;
    if (noteAction === 'send-now') {
      c.activeLine = null; redrawFileDiff(active.file);
      return draftFollowup(`In \`${active.file}\` line ${active.line}:\n> ${active.code}\n\n${text}`);
    }
    if (!text) { $('#inline-note-input')?.focus(); return; }
    c.notes.push({ id:`n${Date.now()}${Math.random().toString(36).slice(2, 6)}`, file:active.file, line:active.line, code:active.code, comment:text });
    c.activeLine = null;
    renderChanges();
    return;
  }
  if (e.target.closest('#send-review-notes')) {
    if (!c.notes.length) return;
    const text = formatBatchedNotes(c.notes);
    c.notes = []; c.activeLine = null; renderChanges();
    return draftFollowup(text);
  }
  if (e.target.closest('#clear-review-notes')) { c.notes = []; c.activeLine = null; renderChanges(); return; }
  if (e.target.closest('#start-review')) {
    const button = e.target.closest('#start-review'), harness = $('#review-harness')?.value || 'auto';
    button.disabled = true; button.textContent = 'Starting review…';
    try {
      const { task } = await api(`${changesBase()}/review`, { method:'POST', body:JSON.stringify({ harness }) });
      state.followTask = task.id; await refresh(); openTask(task.id);
      showFeedback(`Started ${harnessNames[task.harness] || task.harness} code review.`);
    } catch (error) { showFeedback(error.message); button.disabled = false; button.textContent = 'Review diff ↗'; }
    return;
  }
  const main = e.target.closest('.change-main');
  if (main) {
    const row = main.closest('.change-row'), file = row.dataset.path, diff = row.querySelector('.change-diff');
    if (c.open.has(file)) { c.open.delete(file); row.classList.remove('open'); diff.classList.add('hidden'); return; }
    c.open.add(file); row.classList.add('open'); diff.innerHTML = diffHtml(file); diff.classList.remove('hidden'); loadDiff(file); return;
  }
  const line = e.target.closest('.dl[data-line]');
  if (line && line.dataset.line) {
    const file = line.closest('.change-row').dataset.path, ln = line.dataset.line, code = line.querySelector('code').textContent.trim();
    const prevFile = c.activeLine?.file;
    c.activeLine = c.activeLine?.file === file && String(c.activeLine.line) === String(ln) ? null : { file, line:ln, code };
    if (prevFile && prevFile !== file) redrawFileDiff(prevFile);
    redrawFileDiff(file);
    $('#inline-note-input')?.focus();
    return;
  }
  if (e.target.closest('#send-back')) return draftFollowup('About your changes: ');
  if (e.target.closest('#fix-checks')) {
    const button = e.target.closest('#fix-checks'); button.disabled = true; button.textContent = 'Reading the failed logs…';
    try { const { prompt } = await api(`${changesBase()}/check-logs`, { timeout:60000 }); draftFollowup(prompt); }
    catch (error) { showFeedback(error.message); button.disabled = false; button.textContent = 'Fix failing checks'; }
    return;
  }
  const action = e.target.closest('[data-git]')?.dataset.git;
  if (!action) return;
  if (action === 'merge') {
    const removeAfter = confirm(`Merge branch "${c.data.branch}" into your main checkout? Click OK to merge and clean up this worktree, or Cancel to abort.`);
    if (!removeAfter) return;
    $$('#ship-box button').forEach(b => { b.disabled = true; });
    showFeedback('Merging branch into main checkout…');
    try {
      const result = await api(`${changesBase()}/git`, { method:'POST', body:JSON.stringify({ action:'merge', removeAfter:true }), timeout:120000 });
      c.data = result.changes; c.v = ''; c.diffs.clear(); c.open.clear(); renderChanges();
      showFeedback(`Merged ${result.merge.branch} into ${result.merge.target} (${result.merge.sha}).`);
      await refresh();
    } catch (error) { showFeedback(error.message); $$('#ship-box button').forEach(b => { b.disabled = false; }); }
    return;
  }
  if (action === 'remove-worktree') {
    const dirty = c.data.files.length > 0;
    if (!confirm(dirty ? `This worktree has ${c.data.files.length} uncommitted change(s). Force-remove it and delete branch "${c.data.branch}"?` : `Remove this worktree and delete branch "${c.data.branch}"?`)) return;
    $$('#ship-box button').forEach(b => { b.disabled = true; });
    try {
      await api(`${changesBase()}/git`, { method:'POST', body:JSON.stringify({ action:'remove-worktree', force:dirty, deleteBranch:true }), timeout:60000 });
      showFeedback('Worktree removed.'); closeDrawer(); await refresh();
    } catch (error) { showFeedback(error.message); $$('#ship-box button').forEach(b => { b.disabled = false; }); }
    return;
  }
  const message = $('#commit-message')?.value.trim() || '';
  const verify = Boolean($('#git-verify')?.checked);
  const nothing = !c.data.files.length;
  if (!nothing && action !== 'push' && !message) { $('#commit-message').focus(); return showFeedback('Write a commit message first.'); }
  // "Commit & push" on a clean tree is a plain push; with changes it commits first.
  const steps = action === 'push' && !nothing ? 'ship-no-pr' : action;
  $$('#ship-box button').forEach(b => { b.disabled = true; });
  showFeedback({ commit:'Committing…', push:'Pushing…', 'ship-no-pr':'Committing and pushing…', ship:'Committing, pushing and opening the pull request…' }[steps]);
  try {
    let result;
    if (steps === 'ship-no-pr') { await api(`${changesBase()}/git`, { method:'POST', body:JSON.stringify({ action:'commit', message, verify }), timeout:120000 }); result = await api(`${changesBase()}/git`, { method:'POST', body:JSON.stringify({ action:'push' }), timeout:120000 }); }
    else result = await api(`${changesBase()}/git`, { method:'POST', body:JSON.stringify({ action, message, verify, draft:$('#pr-draft')?.checked }), timeout:120000 });
    c.data = result.changes; c.v = ''; c.diffs.clear(); c.open.clear(); renderChanges();
    if (result.pr?.url) { showFeedback(result.pr.existing ? 'Pushed. The pull request is updated.' : 'Pull request opened.'); loadPr(true); }
    else showFeedback(result.push ? `Pushed ${result.push.branch}.` : `Committed ${result.commit?.sha || ''}.`);
  } catch (error) { showFeedback(error.message); $$('#ship-box button').forEach(b => { b.disabled = false; }); }
});
$('#drawer-changes').addEventListener('keydown', e => {
  if (e.target.id === 'inline-note-input' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    $('#drawer-changes [data-note-action="queue"]')?.click();
  }
});
$('#drawer-changes').addEventListener('submit', e => e.preventDefault());
setInterval(() => { if (state.pane === 'changes' && !document.hidden && !$('#detail-drawer').classList.contains('hidden') && !$('#ship-box button:disabled') && !state.changes.activeLine) loadChanges(true); }, 3000);
async function loadBranchSetting() { try { $('#own-branch').checked = (await api('/api/branches')).ownBranch; } catch { /* Settings still work without it. */ } }
$('#own-branch').addEventListener('change', () => api('/api/branches', { method:'POST', body:JSON.stringify({ ownBranch:$('#own-branch').checked }) }).catch(error => showFeedback(error.message)));
// Worktree manager in Settings: view all Shed branch worktrees, clean up merged ones in one tap, or remove individually.
async function loadWorktrees() {
  const listEl = $('#worktree-list'), actionsEl = $('#worktree-actions');
  if (!listEl || !actionsEl) return;
  try {
    const { worktrees } = await api('/api/worktrees');
    const merged = worktrees.filter(w => w.merged && !w.dirty);
    actionsEl.innerHTML = worktrees.length
      ? `${merged.length ? `<button class="send-button" type="button" id="wt-cleanup">Clean up ${merged.length} merged worktree${merged.length === 1 ? '' : 's'}</button>` : ''}<button class="text-action" type="button" id="wt-refresh">Refresh worktrees (${worktrees.length})</button>`
      : '<span class="settings-note">No active Shed branch worktrees right now.</span>';
    listEl.innerHTML = worktrees.map(w => {
      const tags = [
        w.merged ? '<span class="wt-tag merged">MERGED</span>' : '',
        w.dirty ? `<span class="wt-tag dirty">${w.filesCount} UNCOMMITTED</span>` : '<span class="wt-tag">CLEAN</span>',
        w.ahead ? `<span class="wt-tag">+${w.ahead} ahead</span>` : '',
      ].filter(Boolean).join('');
      return `<div class="device-row"><div><b>${escapeHtml(w.repoName)} · ${escapeHtml(w.branch)}${tags}</b><small>${escapeHtml(w.head?.subject || w.path)}${w.head?.date ? ` · ${relative(w.head.date)}` : ''}</small></div><div class="device-actions"><button class="pill danger" type="button" data-wt-remove="${escapeHtml(w.path)}" data-wt-dirty="${w.dirty ? '1' : '0'}" data-wt-branch="${escapeHtml(w.branch)}">Remove</button></div></div>`;
    }).join('');
  } catch { listEl.innerHTML = ''; actionsEl.innerHTML = ''; }
}
$('#branch-settings')?.addEventListener('click', async e => {
  if (e.target.closest('#wt-refresh')) return loadWorktrees();
  if (e.target.closest('#wt-cleanup')) {
    const btn = e.target.closest('#wt-cleanup'); btn.disabled = true;
    try {
      const res = await api('/api/worktrees/cleanup', { method:'POST', body:JSON.stringify({}) });
      showFeedback(`Removed ${res.removed.length} merged worktree${res.removed.length === 1 ? '' : 's'}.`);
      loadWorktrees(); refresh();
    } catch (error) { showFeedback(error.message); btn.disabled = false; }
    return;
  }
  const rm = e.target.closest('[data-wt-remove]');
  if (rm) {
    const dirty = rm.dataset.wtDirty === '1', branch = rm.dataset.wtBranch;
    if (!confirm(dirty ? `Worktree "${branch}" has uncommitted changes. Force-remove it?` : `Remove worktree "${branch}"?`)) return;
    rm.disabled = true;
    try {
      await api('/api/worktrees/remove', { method:'POST', body:JSON.stringify({ path:rm.dataset.wtRemove, force:dirty, deleteBranch:true }) });
      showFeedback(`Removed ${branch}.`); loadWorktrees(); refresh();
    } catch (error) { showFeedback(error.message); rm.disabled = false; }
  }
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
  if (reset) { view.textContent = 'Reading the terminal…'; $('#terminal-controls').classList.remove('asking'); renderChoices(null); }
  if (!state.login) $('#terminal-caption').textContent = `Live · ${target.tty.replace("/dev/", "")} on the Mac · updates every 2s`;
  try {
    const data = await api(`${target.url}?v=${reset ? '' : state.terminalV?.[target.key] || ''}`);
    if (terminalTarget()?.key !== target.key || data.same) return;
    state.terminalV = { [target.key]:data.v };
    const { text, menu } = data;
    const screen = text.split('\n').slice(-20).join('\n');
    const isAg = state.selectedSession?.harness === 'antigravity' || state.tasks.find(t => t.id === state.selectedTask)?.harness === 'antigravity';
    const askRe = isAg ? /Do you want to|Enter to confirm|enter Confirm|enter Toggle|Allow .*\?|\(y\/n\)|\[y\/n\]|❯\s*1\.|Would you like to|Press enter to confirm|›\s*1\.\s/i : /Do you want to|Esc to cancel|Enter to confirm|enter Confirm|enter Toggle|Allow .*\?|\(y\/n\)|\[y\/n\]|❯\s*1\.|Would you like to|Press enter to confirm|›\s*1\.\s/i;
    $('#terminal-controls').classList.toggle('asking', Boolean(menu) || askRe.test(screen));
    renderChoices(menu);
    const atBottom = reset || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    // A wide desktop drawer shows the terminal exactly as laid out; a phone gets the reflowed version.
    view.textContent = wideTerminal.matches ? text.split('\n').map(line => line.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n') : tidyTerminal(text);

    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  } catch (error) { view.textContent = error.message; }
}
function openDrawer() { $('#detail-drawer').classList.remove('hidden'); $('#drawer-backdrop').classList.remove('hidden'); }
function closeDrawer() { $('#detail-drawer').classList.remove('wide'); state.selectedSession = null; state.selectedTask = null; state.selectedComparison = null; state.login = null; $('#detail-drawer').classList.remove('login-mode'); $('#detail-drawer').classList.add('hidden'); $('#drawer-backdrop').classList.add('hidden'); }
// A sent message stays visible below the conversation, with its delivery state, until the transcript shows it.
function pendingMessages(session, messages) {
  const recorded = new Set(messages.filter(m => m.role === 'user').map(m => m.text.replace(/\s+/g, ' ').trim()));
  state.pending = state.pending.filter(p => !(p.sessionId === session.id && recorded.has(p.text.replace(/\s+/g, ' ').trim())) && Date.now() - p.at < 30 * 60 * 1000);
  return state.pending.filter(p => p.sessionId === session.id).map(p => {
    const task = state.tasks.find(t => t.id === p.taskId);
    const failed = task?.status === 'failed';
    const status = failed ? `Not delivered: ${task.error || 'see the task for details'}` : task?.waitingOn ? `Waiting for an answer in the Terminal tab: ${task.waitingOn}` : task?.status === 'completed' ? 'Delivered' : task?.delivery === 'terminal' ? 'Sending to the terminal…' : 'Working on it…';
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
    state.selectedComparison = null;
    $('#end-session').classList.toggle('hidden', !session.canEnd);
    $('#open-talk').classList.toggle('hidden', !talkTargets(session).length);
    $('#end-session').textContent = session.harness === 'codex' && !session.tty ? 'Stop Codex' : 'End session';
    const listed = state.sessions.find(s => s.id === session.id);
    $('#hide-session').classList.toggle('hidden', session.canEnd || session.liveState !== 'history' || !listed);
    $('#hide-session').textContent = listed?.hidden ? 'Put back' : 'Clear';
    if (!silent) { state.login = null; $('#detail-drawer').classList.remove('login-mode'); }
    renderModelChoices();
    const status = session.liveState === 'history' ? 'HISTORY' : session.liveState === 'working' ? 'WORKING NOW' : session.liveState === 'asking' ? 'NEEDS YOUR OK' : 'OPEN ON DESKTOP';
    $('#drawer-harness').innerHTML = `${symbol(session.harness)} <span style="vertical-align:middle;margin-left:7px">${escapeHtml(session.harness.toUpperCase())} · ${status}${permissionTag(session)}</span>`;
    const permissions = $('#followup-permissions'), line = permissionLine(session);
    // Left alone while the picker is in use, so a refresh never closes it or undoes a pick in progress.
    if (permissions.dataset.line !== line && !permissions.querySelector('select:focus, select:disabled')) { permissions.innerHTML = line; permissions.dataset.line = line; }
    permissions.classList.toggle('hidden', !line);
    const changed = setDrawerContent(`<header class="chat-head"><h2 class="drawer-title">${escapeHtml(projectName(session.cwd) || 'Untitled project')}</h2><p class="chat-topic" title="${escapeHtml(session.title)}">${escapeHtml(topicLine(session.title))}</p><div class="drawer-path">${escapeHtml(session.cwd || 'Unknown folder')} · updated ${relative(session.updatedAt)}</div>${sessionTalk(session)}</header>${messages.length ? messages.map(m => messageHtml(m, session)).join('') : '<div class="table-empty">No messages found in this session record.</div>'}${pendingMessages(session, messages)}`, !silent);
    if (silent) { if (changed) content.scrollTop = state.pinBottom || stickToBottom ? content.scrollHeight : priorScroll; }
    else { state.pinBottom = true; content.scrollTop = content.scrollHeight; }
    $('#drawer-tabs').classList.toggle('hidden', !session.tty && !session.cwd);
    $('#drawer-tabs [data-pane=terminal]').classList.toggle('hidden', !session.tty);
    $('#drawer-tabs [data-pane=files]').classList.toggle('hidden', !session.cwd);
    $('#drawer-tabs [data-pane=changes]').classList.toggle('hidden', !session.cwd);
    if (!silent) { state.files = { key:'', list:[] }; state.changes = { id:session.id, v:'', scope:'uncommitted', data:null, open:new Set(), diffs:new Map(), notes:[], activeLine:null, checkpoints:[], cpDiff:null, scripts:[], scriptRuns:{}, activeScriptId:'', runningScriptId:'' }; $('#changes-count').classList.add('hidden'); showPane('conversation'); if (session.cwd) loadChanges(true); loadSessionQueue(session.id); fetchFiles(`/api/sessions/${encodeURIComponent(session.id)}`).then(() => openSession(session.id, true)); }
    else if (!session.tty && state.pane === 'terminal') showPane('conversation');
    $('#followup-skip-wrap').classList.toggle('hidden', Boolean(session.tty));
    $('.drawer-composer').classList.remove('hidden');
    const missingGeminiProject = session.harness === 'gemini' && !session.cwd;
    const isWorking = session.liveState === 'working';
    const willQueue = isWorking && !['codex', 'claude'].includes(session.harness) && !(session.harness === 'antigravity' && session.tty);
    const harnessReady = state.health[session.harness]?.state === 'ready';
    const canHandOff = !['auto', 'stay', session.harness].includes($('#followup-route').value);
    $('#followup-send').disabled = (!harnessReady && !canHandOff) || missingGeminiProject;
    $('#followup-send').textContent = willQueue ? 'Queue ↗' : 'Send ↗';
    $('#followup-steer')?.classList.toggle('hidden', !isWorking || !harnessReady);
    $('#followup-prompt').disabled = missingGeminiProject;
    $('#followup-prompt').placeholder = missingGeminiProject ? 'Original Gemini project path is unavailable' : !harnessReady ? (canHandOff ? 'Send to the handoff you selected…' : `${session.harness} is not ready; restore it or choose a handoff…`) : isWorking ? 'Queue a follow-up, or tap Steer ↯ to redirect mid-run…' : session.harness === 'codex' && session.liveState !== 'history' && !session.tty ? 'Queue a follow-up for this Codex session…' : session.harness === 'antigravity' && session.agAppOnly ? 'Continue in a new Antigravity Terminal session (carries recent context)…' : session.tty ? `Message ${harnessNames[session.harness] || session.harness}…` : ['claude', 'codex', 'antigravity'].includes(session.harness) ? `Message ${harnessNames[session.harness]} (it reopens in Terminal on the Mac)…` : 'Continue this session…';
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
function renderTask(task, silent = false) { const id = task.id; $('#end-session').classList.add('hidden'); $('#open-talk').classList.add('hidden'); $('#followup-permissions').classList.add('hidden'); if (state.followTask === task.id && task.sessionId && state.sessions.some(s => s.id === task.sessionId)) { state.followTask = null; state.pinBottom = true; return openSession(task.sessionId); } if (!silent) { state.files = { key:'', list:[] }; if (task.cwd) fetchFiles(`/api/tasks/${encodeURIComponent(task.id)}`).then(() => openTask(task.id, true)); } state.selectedTask = id; state.selectedSession = null; state.selectedComparison = null; state.login = null; $('#detail-drawer').classList.remove('login-mode'); $('#drawer-harness').innerHTML = `${symbol(task.harness)} <span style="vertical-align:middle;margin-left:7px">TASK · ${escapeHtml(task.status.toUpperCase())}</span>`; const scroll = $('#drawer-content').scrollTop; const changed = setDrawerContent(`<h2 class="drawer-title">${escapeHtml(task.title)}</h2><div class="drawer-path">${escapeHtml(task.cwd)} · ${relative(task.createdAt)}</div><div class="message"><div class="message-label">ROUTING · ${escapeHtml((task.routeSource || 'local').toUpperCase())}</div><div class="message-body">${escapeHtml(task.routeReason)}${task.handoffFrom ? `\nHanded off from: ${escapeHtml(task.handoffFrom)}` : ''}${task.sessionId ? `\nSession: ${escapeHtml(task.sessionId)}` : ''}${task.waitingOn && task.status === 'running' ? `\nWaiting for your answer in its Terminal tab: ${escapeHtml(task.waitingOn)}` : ''}${task.tty ? `\nTerminal on the Mac: ${escapeHtml(task.tty.replace('/dev/', ''))}${task.permissions === 'skip' ? ' · permissions skipped' : task.permissions === 'default' ? ' · asks before using tools' : " · uses that terminal's own permissions"}` : ''}${task.routeFallbackReason ? `\n${escapeHtml(task.routeFallbackReason)}` : ''}</div></div><div class="message"><div class="message-label">MODEL · ${escapeHtml((task.modelSource || 'harness-default').toUpperCase())}</div><div class="message-body">${escapeHtml(task.model || (task.modelSource === 'session' ? 'Current session model' : 'Harness default'))} · ${escapeHtml(task.modelReason || '')}${task.modelFallbackReason ? `\n${escapeHtml(task.modelFallbackReason)}` : ''}</div></div><div class="message user"><div class="message-label">YOUR PROMPT</div><div class="message-body">${escapeHtml(task.prompt)}${(task.attachments || []).length ? `<ul class="attached-paths">${task.attachments.map(p => `<li title="${escapeHtml(p)}">📎 ${escapeHtml(p.split('/').pop())}<small>${escapeHtml(p)}</small></li>`).join('')}</ul>` : ''}</div></div><div class="message"><div class="message-label">${escapeHtml(task.harness.toUpperCase())} · ${escapeHtml(task.status.toUpperCase())}</div><div class="message-body md">${task.output ? renderMarkdown(task.output) : escapeHtml(task.status === 'running' ? 'Working on it…' : 'No output yet.')}</div>${fileChips(task.output)}</div>${task.error ? `<div class="message"><div class="message-label">DETAILS</div><div class="message-body">${escapeHtml(task.error)}</div></div>` : ''}${task.delivery !== 'queue' && ['running','cancelling'].includes(task.status) ? `<button class="pill" id="cancel-task" ${task.status === 'cancelling' ? 'disabled' : ''}>Cancel task</button>` : ''}${task.mode === 'plan' && task.status === 'completed' && task.sessionId ? `<button class="send-button" id="approve-plan" data-plan-session="${escapeHtml(task.sessionId)}" style="margin-left:8px">Approve &amp; execute plan ↗</button>` : ''}${task.sessionId ? `<button class="pill" id="open-task-session" style="margin-left:8px">Open session ↗</button>` : ''}`, !silent); if (!silent) $('#drawer-content').scrollTop = 0; else if (changed) $('#drawer-content').scrollTop = scroll; $('#drawer-tabs').classList.toggle('hidden', !task.tty); $('#drawer-tabs [data-pane=terminal]').classList.toggle('hidden', !task.tty); $('#drawer-tabs [data-pane=files]').classList.add('hidden'); if (!silent || !task.tty) showPane('conversation'); $('.drawer-composer').classList.add('hidden'); if (!silent) openDrawer(); }
$('#auth-form').addEventListener('submit', async e => { e.preventDefault(); try { const code = pairCode || ($('#auth-pair-code')?.value || '').trim(); const result = await api('/api/auth', { method:'POST', body:JSON.stringify({ password:$('#auth-password').value, pairCode:code }) }); $('#auth-error').textContent = ''; $('#auth-password').value = ''; if ($('#auth-pair-code')) $('#auth-pair-code').value = ''; if (result.status === 'pending') return showWaiting(result.device?.name); await init(); } catch (error) { $('#auth-error').textContent = error.message; } });
$('#show-password-setup').addEventListener('click', () => { $('#password-setup').classList.toggle('hidden'); $('#setup-password').focus(); });
$('#password-setup').addEventListener('submit', async e => { e.preventDefault(); const password = $('#setup-password').value; if (password !== $('#setup-password-confirm').value) { $('#auth-error').textContent = 'Passwords do not match.'; return; } try { await api('/api/password/setup', { method:'POST', body:JSON.stringify({ password }) }); $('#auth-error').textContent = 'Password saved. Unlocking…'; await api('/api/auth', { method:'POST', body:JSON.stringify({ password }) }); $('#password-setup').reset(); await init(); } catch (error) { $('#auth-error').textContent = error.message; } });
$('#logout-button').addEventListener('click', async () => { forgetBoot(); await api('/api/logout', { method:'POST' }); closeDrawer(); showAuth(); });
$$('.nav-item').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$('#view-live').addEventListener('click', () => { state.filter = 'live'; $$('#session-filters .pill').forEach(p => p.classList.toggle('active', p.dataset.filter === 'live')); setView('sessions'); });
$('#view-sessions').addEventListener('click', () => setView('sessions'));
$('#session-search').addEventListener('input', render);
$$('#session-filters .pill').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; $$('#session-filters .pill').forEach(p => p.classList.toggle('active', p === button)); render(); }));
$('#prompt').addEventListener('input', () => { clearTimeout(state.previewTimer); state.previewTimer = setTimeout(previewRoute, 450); });
async function openLogin(name) {
  try {
    const { tty } = await api(`/api/harnesses/${name}/login`, { method:'POST' });
    state.selectedSession = null; state.selectedTask = null; state.login = { harness:name, tty, ready:false }; $('#end-session').classList.add('hidden'); $('#open-talk').classList.add('hidden');
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
function toggleSkipPermissions() { $('#skip-wrap').classList.toggle('hidden', !['auto', 'claude', 'codex', 'antigravity'].includes($('#harness-select').value)); }
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
    const harness = harnessNames[route.harness] || route.harness;
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
setInterval(() => loadTerminal(), 1000);
// Typing on the terminal's own prompt line sends a tracked follow-up into that same terminal (Shift+Enter for a new line).
// The agent's question as buttons with its own wording. A tap sends the option and its text; the Mac checks the
// question is still the same, moves the pointer there with arrow keys and presses Return.
function renderChoices(menu) {
  const box = $('#terminal-choices');
  box.classList.toggle('hidden', !menu);
  if (!menu) { box.innerHTML = ''; box.dataset.key = ''; return; }
  const key = JSON.stringify(menu);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = menu.options.map((label, i) => `<button type="button" data-option="${i}" class="${i === menu.current ? 'current' : ''}">${escapeHtml(label.replace(/^\d+\.\s+/, ''))}</button>`).join('');
  box._menu = menu;
}
$('#terminal-choices').addEventListener('click', async e => {
  const button = e.target.closest('[data-option]'), target = terminalTarget(), menu = $('#terminal-choices')._menu;
  if (!button || !target || !menu) return;
  const index = Number(button.dataset.option);
  $$('#terminal-choices button').forEach(b => { b.disabled = true; });
  button.classList.add('sending');
  try { await api(target.url, { method:'POST', body:JSON.stringify({ option:index, label:menu.options[index] }) }); }
  catch (error) { showFeedback(error.message); }
  finally { setTimeout(() => { $$('#terminal-choices button').forEach(b => { b.disabled = false; b.classList.remove('sending'); }); loadTerminal(); }, 700); }
});
async function sendTerminalLine() {
  const box = $('#terminal-prompt'), target = terminalTarget(), prompt = box.value;
  if (!target || !prompt.trim() || box.disabled) return;
  box.disabled = true;
  try {
    // A session line is a tracked follow-up; a sign-in window just gets the text typed in.
    if (state.login) await api(target.url, { method:'POST', body:JSON.stringify({ text:prompt }) });
    else {
      // In a new session's own view the session may not be known yet (for example while it asks to trust the folder).
      const sessionId = state.selectedSession?.id || state.tasks.find(t => t.id === state.selectedTask)?.sessionId;
      if (!sessionId) throw new Error($('#terminal-choices').classList.contains('hidden') ? 'This session is still starting. Try again in a moment.' : 'Answer the question above first.');
      await api('/api/tasks', { method:'POST', body:JSON.stringify({ prompt, sessionId, followup:'stay', harness:'auto', model:'', newSession:false }) });
    }
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
// Ending a session stops its agent (and whatever command it is running). The Terminal window stays open on the Mac.
$('#hide-session').addEventListener('click', async () => {
  const session = state.selectedSession, listed = session && state.sessions.find(s => s.id === session.id);
  if (!listed) return;
  const button = $('#hide-session'); button.disabled = true;
  try { await hideSessions([listed.id], !listed.hidden); showFeedback(listed.hidden ? 'Put back in Sessions.' : 'Cleared from Sessions. Show cleared on the Sessions page brings it back.'); closeDrawer(); }
  catch (error) { showFeedback(error.message); }
  finally { button.disabled = false; }
});
$('#end-session').addEventListener('click', async () => {
  const session = state.selectedSession;
  const inCodexApp = session?.harness === 'codex' && !session.tty;
  if (!session || !confirm(inCodexApp
    ? 'Stop what Codex is doing in this session? Its current turn ends at once. The session stays open in the Codex app.'
    : `End this ${harnessNames[session.harness] || session.harness} session? The agent stops at once, including any command it is running. You can resume it later.`)) return;
  const button = $('#end-session'); button.disabled = true; button.textContent = 'Ending…';
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session.id)}/end`, { method:'POST' });
    showFeedback(result.mode === 'interrupted' ? 'Codex stopped its current turn. The session is still open in the Codex app.'
      : result.mode === 'idle' ? 'Codex was not working on anything, so there was nothing to stop.'
      : result.forced ? 'The session did not exit on its own, so Shed force-stopped it.' : 'Session ended.');
    if (!inCodexApp) button.classList.add('hidden');
    await refresh(); openSession(session.id, true);
  } catch (error) { showFeedback(error.message); }
  finally { button.disabled = false; button.textContent = inCodexApp ? 'Stop Codex' : 'End session'; }
});
$('#terminal-controls').addEventListener('click', async e => {
  const button = e.target.closest('[data-key]'), target = terminalTarget();
  if (!button || !target) return;
  try { await api(target.url, { method:'POST', body:JSON.stringify({ text:button.dataset.key }) }); setTimeout(() => loadTerminal(), 600); }
  catch (error) { showFeedback(error.message); }
});
// Connecting another device: QR code, copyable pairing link, and 6-digit one-time pairing code.
let connectInfo = null;
async function loadConnect() {
  try {
    const data = await api('/api/connect');
    connectInfo = data;
    const [badgeText, badgeCls] = remoteBadgeFor(data);
    if ($('#connect-badge')) { $('#connect-badge').textContent = badgeText; $('#connect-badge').className = `badge ${badgeCls}`; }
    if (!data.url) {
      $('#connect-qr').innerHTML = ''; $('#connect-card').classList.add('hidden');
      $('#connect-url').textContent = ''; $('#connect-pair-bar')?.classList.add('hidden');
      $('#connect-note').textContent = data.detail || 'Remote access is not running right now. Check Settings → Remote access on the Mac.';
      return;
    }
    $('#connect-qr').innerHTML = data.qr; $('#connect-card-qr').innerHTML = data.qr;
    $('#connect-url').textContent = data.link || data.url; $('#connect-url').href = data.url;
    const hasPair = Boolean(data.shortCode);
    $('#connect-pair-bar')?.classList.toggle('hidden', !hasPair);
    if (hasPair) $('#connect-code').textContent = data.shortCode;
    $('#connect-note').textContent = data.secure
      ? `${data.permanent ? 'Permanent HTTPS address.' : 'Temporary Quick Tunnel link.'} This QR and 6-digit code pair one device for 10 minutes; your password is still required.`
      : 'Remote tunnel is not running, so this address only works on the same Wi-Fi as the Mac, over plain http.';
    $('#connect-card').classList.toggle('hidden', Boolean(data.phoneConnectedAt));
  } catch {}
}
$('#connect-copy-code')?.addEventListener('click', () => { if (connectInfo?.shortCode) copyText(connectInfo.shortCode, 'Pairing code copied.'); });
$('#connect-copy-link')?.addEventListener('click', () => { if (connectInfo?.url) copyText(connectInfo.url, 'One-time pairing link copied.'); });
function openConnect() { loadConnect(); $('#connect-dialog').showModal(); }
// The QR code's pairing code lasts 10 minutes, so a QR left on the Mac's screen is refreshed before it expires.
setInterval(() => { if (state.local && $('#auth-screen').classList.contains('hidden')) loadConnect(); }, 5 * 60 * 1000);
$('#connect-phone').addEventListener('click', openConnect);
$('#connect-card-more').addEventListener('click', openConnect);
$('#connect-close').addEventListener('click', () => $('#connect-dialog').close());
$('#talk-close').addEventListener('click', () => $('#talk-dialog').close());
$('#talk-form').addEventListener('submit', async event => {
  event.preventDefault();
  const from = state.selectedSession, to = $('#talk-target').value, button = $('#talk-send');
  if (!from || !to) return;
  button.disabled = true;
  try {
    await api('/api/exchanges/introduce', { method:'POST', body:JSON.stringify({ from:from.id, to, note:$('#talk-note').value }) });
    $('#talk-note').value = ''; $('#talk-dialog').close();
    showFeedback(`Introduced. ${sessionName(from.id)} now knows how to reach ${sessionName(to)}.`);
    await refresh();
  } catch (error) { showFeedback(error.message); }
  finally { button.disabled = false; }
});
document.addEventListener('click', e => {
  if (e.target.id === 'open-talk') return openTalk();
  const row = e.target.closest('.talk-row');
  if (row?.dataset.session && state.sessions.some(s => s.id === row.dataset.session)) openSession(row.dataset.session);
});
$('#connect-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
// On a phone, the command center has a message bar: type and send, and Laya picks the agent.
// The phone bar's agent picker mirrors the main composer's harness list (same readiness, "Auto" for Laya).
function syncPhoneHarness() {
  const source = $('#harness-select'), picker = $('#phone-harness'), current = picker.value || 'auto';
  setOptions(picker, [...source.options].map(o => `<option value="${escapeHtml(o.value)}"${o.disabled ? ' disabled' : ''}>${o.value === 'auto' ? '✦ Auto' : escapeHtml(o.textContent)}</option>`).join(''));
  picker.value = [...picker.options].some(o => o.value === current && !o.disabled) ? current : 'auto';
  syncPhoneModel();
}
// The phone's model picker: shown once an agent is picked, listing that agent's models from Settings.
function syncPhoneModel() {
  const harness = $('#phone-harness').value, picker = $('#phone-model'), current = picker.value;
  setOptions(picker, '<option value="">✦ Model</option>' + (harness === 'auto' ? '' : modelOptions(harness)));
  picker.value = [...picker.options].some(o => o.value === current) ? current : '';
  picker.classList.toggle('hidden', picker.options.length < 2);
  $('#phone-perms').classList.toggle('hidden', !['auto', 'claude', 'codex', 'antigravity'].includes(harness));
}
$('#phone-harness').addEventListener('change', syncPhoneModel);
async function sendPhoneMessage() {
  const box = $('#phone-message-input'), text = box.value;
  if (!text.trim() && !attached.phone.length) return;
  $('#harness-select').value = $('#phone-harness').value; renderModelChoices(); $('#model-select').value = $('#phone-model').value; $('#skip-permissions').checked = $('#phone-perms').value === 'skip';
  const project = $('#phone-project').value, workspace = $('#phone-workspace').value.trim();
  if (project === '__new__' && !workspace) { $('#phone-workspace').focus(); return showFeedback('Name the new workspace first.'); }
  $('#project-select').value = project; $('#new-workspace').value = project === '__new__' ? workspace : ''; toggleNewWorkspace();
  if (await sendTask(text, { phone:true })) {
    box.value = ''; box.style.height = '';
    if (project === '__new__') { $('#phone-workspace').value = ''; $('#phone-workspace').classList.add('hidden'); $('#phone-project').value = ''; }
  }
}
$('#phone-message').addEventListener('submit', e => { e.preventDefault(); sendPhoneMessage(); });
$('#phone-message-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendPhoneMessage(); } });
$('#phone-message-input').addEventListener('input', e => { e.target.style.height = ''; e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`; });
// Attachments: picked files upload to the Mac at once; sending moves them into the project and gives the agent their paths.
const attached = { new:[], followup:[], phone:[] };
let attachTarget = 'new';
const formatSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
function renderAttachments(key) {
  const tray = $(`#attach-${key}`);
  tray.classList.toggle('hidden', !attached[key].length);
  tray.innerHTML = attached[key].map((f, i) => `<span class="attach-chip ${f.status}"><span class="attach-name">${escapeHtml(f.name)}</span><small>${f.status === 'uploading' ? 'Uploading…' : f.status === 'failed' ? escapeHtml(f.error || 'Upload failed') : formatSize(f.size)}</small><button type="button" data-remove-attachment="${key}:${i}" aria-label="Remove ${escapeHtml(f.name)}">×</button></span>`).join('');
}
async function uploadAttachment(key, file) {
  const item = { name:file.name, size:file.size, status:'uploading' };
  attached[key].push(item); renderAttachments(key);
  if (file.size > 100 * 1048576) { Object.assign(item, { status:'failed', error:'Over 100 MB' }); return renderAttachments(key); }
  try {
    const res = await fetch('/api/uploads', { method:'POST', credentials:'same-origin', headers:{ 'X-File-Name':encodeURIComponent(file.name), 'Content-Type':file.type || 'application/octet-stream' }, body:file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    Object.assign(item, { id:data.id, name:data.name, size:data.size, status:'ready' });
  } catch (error) { Object.assign(item, { status:'failed', error:error.message === 'Failed to fetch' ? 'Could not reach your Mac' : error.message }); }
  if (attached[key].includes(item)) renderAttachments(key);
  else if (item.id) fetch(`/api/uploads/${item.id}`, { method:'DELETE', credentials:'same-origin' }).catch(() => {});
}
document.addEventListener('click', e => {
  const button = e.target.closest('[data-attach]');
  if (button) { attachTarget = button.dataset.attach; $('#attach-input').click(); return; }
  const remove = e.target.closest('[data-remove-attachment]');
  if (!remove) return;
  const [key, index] = remove.dataset.removeAttachment.split(':');
  const [item] = attached[key].splice(Number(index), 1);
  if (item?.id) fetch(`/api/uploads/${item.id}`, { method:'DELETE', credentials:'same-origin' }).catch(() => {});
  renderAttachments(key);
});
$('#attach-input').addEventListener('change', e => {
  const files = [...e.target.files].slice(0, Math.max(0, 10 - attached[attachTarget].length));
  if (e.target.files.length > files.length) showFeedback('Up to 10 files per message.');
  files.forEach(file => uploadAttachment(attachTarget, file));
  e.target.value = '';
});
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
document.addEventListener('click', e => {
  const compRow = e.target.closest('[data-compare]');
  if (compRow) return openComparison(compRow.dataset.compare);
  const pickBtn = e.target.closest('[data-pick-winner]');
  if (pickBtn) return pickComparisonWinner(pickBtn.dataset.pickComp, pickBtn.dataset.pickWinner);
  const row = e.target.closest('[data-session]'); if (row) openSession(row.dataset.session); const task = e.target.closest('[data-task]'); if (task) openTask(task.dataset.task); if (e.target.id === 'cancel-task' && state.selectedTask) api(`/api/tasks/${state.selectedTask}/cancel`, { method:'POST' }).then(refresh).catch(err => showFeedback(err.message)); if (e.target.id === 'open-task-session') { const item = state.tasks.find(t => t.id === state.selectedTask); if (item?.sessionId) openSession(item.sessionId); }
});

// Fan-out & Compare ("Race Agents"): run one prompt across 2–4 harnesses in parallel worktrees and pick a winner.
function readyHarnesses() { return Object.keys(harnessNames).filter(h => state.available[h] && state.health[h]?.state === 'ready'); }
function renderComparePicker() {
  const picker = $('#compare-picker');
  if (!picker) return;
  const ready = readyHarnesses();
  for (const h of [...state.compareHarnesses]) if (!ready.includes(h)) state.compareHarnesses.delete(h);
  if (state.compareHarnesses.size < 2 && ready.length >= 2) {
    for (const h of ready) { state.compareHarnesses.add(h); if (state.compareHarnesses.size >= 2) break; }
  }
  const isCompare = state.composerMode === 'compare';
  picker.classList.toggle('hidden', !isCompare);
  $('#harness-select')?.closest('.select-wrap')?.classList.toggle('hidden', isCompare);
  $('#model-select')?.closest('.select-wrap')?.classList.toggle('hidden', isCompare);
  if (isCompare) {
    picker.innerHTML = ready.length < 2
      ? '<span class="compare-picker-label">Need at least 2 ready harnesses to compare side-by-side.</span>'
      : `<span class="compare-picker-label">Compare in parallel branches (pick 2–4)</span>${ready.map(h => `<label class="compare-chip"><input type="checkbox" value="${h}"${state.compareHarnesses.has(h) ? ' checked' : ''}>${symbol(h)} ${escapeHtml(harnessNames[h] || h)}</label>`).join('')}`;
  }
  const btn = $('#send-button');
  if (btn) btn.innerHTML = isCompare ? `Compare ${Math.max(2, state.compareHarnesses.size)} agents <span>↗</span>` : 'Start session <span>↗</span>';
}
$$('[data-composer-mode]').forEach(btn => btn.addEventListener('click', () => {
  state.composerMode = btn.dataset.composerMode;
  $$('[data-composer-mode]').forEach(b => b.classList.toggle('active', b === btn));
  renderComparePicker(); previewRoute();
}));
$$('[data-run-mode]').forEach(btn => btn.addEventListener('click', () => {
  state.runMode = btn.dataset.runMode === 'plan' ? 'plan' : 'build';
  $$('[data-run-mode]').forEach(b => b.classList.toggle('active', b === btn));
  $('#prompt').placeholder = state.runMode === 'plan' ? 'Describe what you want planned before editing any files…' : 'What should the new agent work on?';
}));

// Universal per-session follow-up queue & mid-run steering.
function renderSessionQueue() {
  const box = $('#followup-queue'), items = state.queueItems || [];
  if (!box) return;
  box.classList.toggle('hidden', !items.length);
  if (!items.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="followup-queue-head">Queued (${items.length}) — runs automatically when this turn finishes</div>` + items.map(q => `<div class="queue-row"><span>${q.mode === 'plan' ? '[PLAN] ' : ''}${escapeHtml(q.prompt)}</span><button type="button" class="pill" data-steer-queue="${escapeHtml(q.id)}" title="Interrupt current turn and run this now">Steer now ↯</button><button type="button" class="pill" data-cancel-queue="${escapeHtml(q.id)}" aria-label="Remove queued message">×</button></div>`).join('');
}
async function loadSessionQueue(sessionId) {
  if (!sessionId) { state.queueItems = []; return renderSessionQueue(); }
  try {
    const { items } = await api(`/api/sessions/${encodeURIComponent(sessionId)}/queue`);
    if (state.selectedSession?.id === sessionId) { state.queueItems = items || []; renderSessionQueue(); }
  } catch { state.queueItems = []; renderSessionQueue(); }
}
$('#followup-queue')?.addEventListener('click', async e => {
  const cancel = e.target.closest('[data-cancel-queue]');
  if (cancel) {
    try { const res = await api(`/api/queue/${encodeURIComponent(cancel.dataset.cancelQueue)}`, { method:'DELETE' }); state.queueItems = res.items || []; renderSessionQueue(); }
    catch (error) { showFeedback(error.message); }
    return;
  }
  const steer = e.target.closest('[data-steer-queue]');
  if (steer && state.selectedSession) {
    steer.disabled = true;
    try {
      await api(`/api/sessions/${encodeURIComponent(state.selectedSession.id)}/steer`, { method:'POST', body:JSON.stringify({ queueId:steer.dataset.steerQueue }) });
      showFeedback('Steering session with queued message.');
      loadSessionQueue(state.selectedSession.id); refresh();
    } catch (error) { showFeedback(error.message); steer.disabled = false; }
  }
});
$('#followup-steer')?.addEventListener('click', async () => {
  const session = state.selectedSession, prompt = $('#followup-prompt').value.trim();
  if (!session) return;
  if (!prompt) { $('#followup-prompt').focus(); return showFeedback('Type a steering message first.'); }
  const btn = $('#followup-steer'); btn.disabled = true;
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}/steer`, { method:'POST', body:JSON.stringify({ prompt, mode:$('#followup-mode')?.value || 'build', model:$('#followup-model').value }) });
    $('#followup-prompt').value = ''; $('#followup-prompt').style.height = '';
    showFeedback('Interrupted current turn and delivered steering guidance.');
    await refresh();
  } catch (error) { showFeedback(error.message); }
  finally { btn.disabled = false; }
});
document.addEventListener('click', async e => {
  const planBtn = e.target.closest('#approve-plan');
  if (!planBtn) return;
  const sid = planBtn.dataset.planSession;
  if (!sid) return;
  planBtn.disabled = true;
  try {
    await sendTask('The plan looks good — go ahead and implement it now, then verify with tests.', { sessionId:sid, mode:'build', followup:'stay' });
    showFeedback('Plan approved — implementing now in Build mode.');
  } catch (error) { showFeedback(error.message); planBtn.disabled = false; }
});
$('#compare-picker')?.addEventListener('change', e => {
  if (e.target.type !== 'checkbox') return;
  if (e.target.checked) { if (state.compareHarnesses.size >= 4) { e.target.checked = false; return showFeedback('Compare up to 4 harnesses at once.'); } state.compareHarnesses.add(e.target.value); }
  else state.compareHarnesses.delete(e.target.value);
  renderComparePicker();
});
async function sendComparison(prompt) {
  const files = attached.new;
  if (files.some(f => f.status === 'uploading')) { showFeedback('Wait for the files to finish uploading.'); return false; }
  if (!prompt.trim()) return false;
  const chosen = [...state.compareHarnesses].filter(h => readyHarnesses().includes(h));
  if (chosen.length < 2) { showFeedback('Pick at least 2 ready harnesses to compare.'); return false; }
  const button = $('#send-button'); button.disabled = true;
  try {
    const selectedProject = $('#project-select').value;
    const { comparison } = await api('/api/comparisons', { method:'POST', body:JSON.stringify({
      prompt, harnesses:chosen,
      cwd: selectedProject === '__new__' ? '' : selectedProject,
      newWorkspace: selectedProject === '__new__' ? $('#new-workspace').value : '',
      skipPermissions: $('#skip-permissions').checked,
      attachments: files.map(f => f.id),
    }), timeout:60000 });
    attached.new = []; renderAttachments('new'); $('#prompt').value = ''; $('#new-workspace').value = '';
    showFeedback(`Started ${chosen.length} agents in parallel branches.`);
    await refresh(); openComparison(comparison.id);
    return true;
  } catch (error) { showFeedback(error.message); return false; }
  finally { button.disabled = false; }
}
function renderComparisons() {
  const box = $('#compare-strip');
  if (!box) return;
  const recent = (state.comparisons || []).filter(c => c.status !== 'decided' || Date.now() - Date.parse(c.updatedAt || c.createdAt) < 86400000).slice(0, 4);
  const html = recent.length ? `<div class="talk-head"><h3>Agent comparisons</h3><p>Same prompt, parallel branches. Tap to compare diffs and pick a winner.</p></div>${recent.map(c => `<button class="talk-row ${c.status === 'running' ? 'is-open' : ''}" data-compare="${escapeHtml(c.id)}" type="button"><div class="talk-ends"><b>${escapeHtml(projectName(c.project))}</b><span class="talk-state">${escapeHtml(c.status === 'decided' ? `winner: ${harnessNames[c.winnerHarness] || c.winnerHarness}` : c.status)}</span><span class="time">${relative(c.createdAt)}</span></div><div class="talk-said">${escapeHtml(c.title)}</div><div class="compare-badges">${(c.entries || []).map(e => `<span class="compare-pill${c.winnerTaskId === e.taskId ? ' winner' : ['running', 'queued'].includes(e.status) ? ' running' : ''}">${symbol(e.harness)} ${escapeHtml(harnessNames[e.harness] || e.harness)} · ${escapeHtml(c.winnerTaskId === e.taskId ? 'winner' : e.status)}</span>`).join('')}</div></button>`).join('')}` : '';
  const print = fingerprint(html);
  if (box.dataset.print !== print) { box.innerHTML = html; box.dataset.print = print; box.classList.toggle('hidden', !html); }
}
async function openComparison(id, silent = false) {
  try {
    const { comparison } = await api(`/api/comparisons/${encodeURIComponent(id)}`);
    if (silent && state.selectedComparison !== id) return;
    state.selectedComparison = id; state.selectedSession = null; state.selectedTask = null; state.login = null;
    $('#end-session').classList.add('hidden'); $('#hide-session').classList.add('hidden'); $('#open-talk').classList.add('hidden');
    $('#followup-permissions').classList.add('hidden'); $('#drawer-tabs').classList.add('hidden'); $('.drawer-composer').classList.add('hidden');
    $('#detail-drawer').classList.remove('login-mode');
    showPane('conversation');
    $('#detail-drawer').classList.add('wide');
    $('#drawer-harness').innerHTML = `<span class="harness-symbol claude">⇄</span> <span>COMPARE · ${escapeHtml(comparison.status.toUpperCase())}</span>`;
    const cards = (comparison.entries || []).map(e => {
      const winner = comparison.winnerTaskId === e.taskId;
      const diffLine = e.diff
        ? `<div class="compare-card-diff"><span>${e.diff.filesCount} file${e.diff.filesCount === 1 ? '' : 's'}</span><i class="add">+${e.diff.additions}</i><i class="del">−${e.diff.deletions}</i></div>${e.diff.files?.length ? `<ul class="compare-card-files">${e.diff.files.map(f => `<li>${escapeHtml(f.status === '?' ? 'N' : f.status)} ${escapeHtml(f.path)}</li>`).join('')}</ul>` : ''}`
        : '<div class="compare-card-meta">No git diff yet.</div>';
      return `<div class="compare-card${winner ? ' winner' : ''}">
        <div class="compare-card-head">${symbol(e.harness)}<strong>${escapeHtml(harnessNames[e.harness] || e.harness)}</strong><span class="badge ${escapeHtml(e.status)}" style="margin-left:auto">${escapeHtml(winner ? 'winner' : e.status)}</span></div>
        <div class="compare-card-meta">${escapeHtml([e.model || 'default model', e.branch || projectName(e.cwd)].filter(Boolean).join(' · '))}</div>
        ${diffLine}
        <div class="compare-card-output md">${e.output ? renderMarkdown(e.output) : escapeHtml(e.error || (e.status === 'running' ? 'Working on it…' : 'No reply yet.'))}</div>
        <div class="compare-card-actions">${e.sessionId ? `<button class="pill" type="button" data-session="${escapeHtml(e.sessionId)}">Open session ↗</button>` : `<button class="pill" type="button" data-task="${escapeHtml(e.taskId)}">View task ↗</button>`}${!comparison.winnerTaskId ? `<button class="send-button" type="button" data-pick-comp="${escapeHtml(comparison.id)}" data-pick-winner="${escapeHtml(e.taskId)}">Pick winner</button>` : ''}</div>
      </div>`;
    }).join('');
    setDrawerContent(`<header class="chat-head"><h2 class="drawer-title">${escapeHtml(projectName(comparison.project))}</h2><p class="chat-topic">${escapeHtml(comparison.title)}</p><div class="drawer-path">${escapeHtml(comparison.entries.length)} agents compared · started ${relative(comparison.createdAt)}</div></header><div class="message user"><div class="message-label">PROMPT</div><div class="message-body">${escapeHtml(comparison.prompt)}</div></div><div class="compare-grid">${cards}</div>`, !silent);
    if (!silent) openDrawer();
  } catch (error) { if (!silent) showFeedback(error.message); }
}
async function pickComparisonWinner(compId, taskId) {
  if (!confirm('Keep this branch as the winner and clean up the other comparison worktrees?')) return;
  try {
    let res = await api(`/api/comparisons/${encodeURIComponent(compId)}/pick`, { method:'POST', body:JSON.stringify({ taskId, cleanupOthers:true, force:false }), timeout:60000 });
    if (res.errors?.length && confirm(`${res.errors.length} other worktree(s) had uncommitted changes and were left on disk. Force-remove them now?`)) {
      res = await api(`/api/comparisons/${encodeURIComponent(compId)}/pick`, { method:'POST', body:JSON.stringify({ taskId, cleanupOthers:true, force:true }), timeout:60000 });
    }
    const winner = res.comparison.entries.find(e => e.taskId === taskId);
    showFeedback(`Picked ${harnessNames[winner?.harness] || 'winner'}${res.cleaned?.length ? ` · cleaned up ${res.cleaned.length} branch${res.cleaned.length === 1 ? '' : 'es'}` : ''}.`);
    await refresh();
    if (winner?.sessionId && state.sessions.some(s => s.id === winner.sessionId)) openSession(winner.sessionId);
    else openComparison(compId);
  } catch (error) { showFeedback(error.message); }
}

// GitHub Issue picker: pick an open issue in the selected project to populate the New Session prompt.
$('#pick-issue-btn')?.addEventListener('click', async () => {
  const cwd = $('#project-select').value;
  if (!cwd || cwd === '__new__') return;
  $('#issue-lead').textContent = `Open issues in ${projectName(cwd)}`;
  $('#issue-list').innerHTML = '<div class="files-empty">Loading issues from GitHub…</div>';
  $('#issue-dialog').showModal();
  try {
    const data = await api(`/api/issues?cwd=${encodeURIComponent(cwd)}`);
    if (data.error) { $('#issue-list').innerHTML = `<div class="files-empty">${escapeHtml(data.error)}</div>`; return; }
    if (!data.issues?.length) { $('#issue-list').innerHTML = '<div class="files-empty">No open GitHub issues found in this repository.</div>'; return; }
    $('#issue-list').innerHTML = data.issues.map((i, idx) => `<button type="button" class="issue-item" data-issue-idx="${idx}"><div class="issue-item-top"><span class="issue-num">#${i.number}</span><span>${escapeHtml(i.title)}</span></div><div class="issue-item-meta">${i.labels.map(l => `<span class="issue-label">${escapeHtml(l)}</span>`).join('')}${i.author ? `<span>@${escapeHtml(i.author)}</span>` : ''}${i.updatedAt ? `<span>${relative(i.updatedAt)}</span>` : ''}</div></button>`).join('');
    $('#issue-list')._issues = data.issues;
  } catch (error) { $('#issue-list').innerHTML = `<div class="files-empty">${escapeHtml(error.message)}</div>`; }
});
$('#issue-close')?.addEventListener('click', () => $('#issue-dialog').close());
$('#issue-dialog')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) return e.currentTarget.close();
  const btn = e.target.closest('[data-issue-idx]');
  if (!btn) return;
  const issue = $('#issue-list')._issues?.[Number(btn.dataset.issueIdx)];
  if (!issue) return;
  $('#prompt').value = `Work on GitHub issue #${issue.number}: ${issue.title}\n${issue.url}\n\n${issue.body || ''}`.trim();
  $('#issue-dialog').close();
  $('#prompt').focus();
  previewRoute();
});
document.addEventListener('click', e => { if (e.target.id === 'configure-laya') setView('settings'); });
$('#test-laya').addEventListener('click', async () => { const el = $('#settings-feedback'); el.textContent = 'Testing the local Laya model…'; el.classList.remove('hidden'); try { const result = await api('/api/laya/test', {method:'POST'}); el.textContent = `${result.model} is running locally. Session and model routing are ready.`; const me = await api('/api/me'); Object.assign(state, me); renderHarnesses(); } catch (error) { el.textContent = `Local model test failed: ${error.message}`; } });
$('#start-new-session').addEventListener('click', () => { if (matchMedia('(max-width: 700px)').matches) { $('#phone-message-input').focus(); return; } $('#new-session').scrollIntoView({behavior:'smooth'}); setTimeout(() => $('#prompt').focus(), 350); });
$('#model-editor-harness').addEventListener('change', e => setEditorHarness(e.target.value));
$('#model-rows').addEventListener('input', e => { const row = e.target.closest('[data-index]'); if (!row || !e.target.dataset.field) return; const model = modelState.draft.models[Number(row.dataset.index)]; model[e.target.dataset.field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; });
$('#model-rows').addEventListener('change', e => { if (['enabled','id','label'].includes(e.target.dataset.field)) { const row = e.target.closest('[data-index]'); modelState.draft.models[Number(row.dataset.index)][e.target.dataset.field] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; renderModelEditor(); } });
$('#model-rows').addEventListener('click', e => { const remove = e.target.closest('[data-remove]'); if (!remove) return; const removed = modelState.draft.models.splice(Number(remove.dataset.remove), 1)[0]; if (modelState.draft.defaultModel === removed.id) modelState.draft.defaultModel = ''; renderModelEditor(); });
$('#add-model').addEventListener('click', () => { if (modelState.draft.models.length >= 24) return; modelState.draft.models.push({id:'',label:'',description:'',enabled:true}); renderModelEditor(); $('#model-rows .model-row:last-child input[data-field="id"]')?.focus(); });
$('#default-model').addEventListener('change', e => { modelState.draft.defaultModel = e.target.value; });
$('#save-models').addEventListener('click', async () => { const el = $('#models-feedback'), harness = $('#model-editor-harness').value; try { const { config } = await api('/api/models', { method:'POST', body:JSON.stringify({ harness, ...modelState.draft }) }); modelState.configs[harness] = config; setEditorHarness(harness); renderModelChoices(); el.textContent = `Saved ${config.models.filter(model => model.enabled).length} enabled models for ${harness}. Laya will choose among them when this harness is routed.`; el.classList.remove('hidden'); } catch (error) { el.textContent = error.message; el.classList.remove('hidden'); } });
function setDrawerExpanded(on) { $('#detail-drawer').classList.toggle('expanded', on); const b = $('#expand-drawer'); b.textContent = on ? '⤡' : '⤢'; b.title = b.ariaLabel = on ? 'Shrink panel' : 'Expand panel'; b.setAttribute('aria-pressed', String(on)); try { localStorage.setItem('drawerExpanded', on ? '1' : ''); } catch {} }
try { setDrawerExpanded(localStorage.getItem('drawerExpanded') === '1'); } catch {}
$('#expand-drawer').addEventListener('click', () => setDrawerExpanded(!$('#detail-drawer').classList.contains('expanded')));
$('#close-drawer').addEventListener('click', closeDrawer); $('#drawer-backdrop').addEventListener('click', closeDrawer);
$('#menu-button').addEventListener('click', () => { $('.sidebar').classList.add('open'); $('#mobile-scrim').classList.remove('hidden'); });
$('#mobile-scrim').addEventListener('click', () => { $('.sidebar').classList.remove('open'); $('#mobile-scrim').classList.add('hidden'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); if ((e.metaKey || e.ctrlKey) && ['1','2','3'].includes(e.key)) { e.preventDefault(); setView(({1:'inbox',2:'sessions',3:'activity'})[e.key]); } });
function updateClock() { $('#clock').textContent = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
updateClock(); setInterval(updateClock, 30000); setInterval(() => { if ($('#auth-screen').classList.contains('hidden')) refresh(); }, 5000); setInterval(() => { if ($('#auth-screen').classList.contains('hidden')) refreshHarnessHealth(); }, 30000); init();
