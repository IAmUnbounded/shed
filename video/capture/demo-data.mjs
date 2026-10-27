// The demo world shown in the product reel: a developer ("maya") with six agents at work. Shapes match Shed's API.
const MARK = 'Message from another agent session, sent through Shed';
const HOME = '/Users/maya/code';
const models = JSON.parse(process.env.SHED_MODELS || 'null');

export const demo = {
  state() {
    const now = Date.now();
    const ago = minutes => new Date(now - minutes * 60000).toISOString();
    const s = (id, harness, title, project, liveState, minutes, extra = {}) => ({ id, nativeId:id.split(':')[1], harness, title, lastPrompt:title, cwd:`${HOME}/${project}`, currentModel:{ claude:'claude-opus-5-5', codex:'gpt-6-sol', gemini:'gemini-2.5-pro', opencode:'', pi:'' }[harness], permissions:'default', updatedAt:ago(minutes), source:'desktop', liveState, tty:liveState === 'history' ? '' : `/dev/ttys00${Math.floor(Math.random() * 9)}`, ...extra });
    const sessions = [
      s('claude:web', 'claude', 'Make the checkout page load faster', 'web-app', 'working', 0),
      s('codex:api', 'codex', 'Add pagination to the orders API', 'orders-api', 'working', 1),
      s('claude:mobile', 'claude', 'Fix the flaky login test', 'mobile-app', 'asking', 0),
      s('claude:bakery', 'claude', 'Build a landing page for my bakery', 'bakery-site', 'open', 3),
      s('gemini:ops', 'gemini', 'Summarise today’s error logs', 'ops', 'open', 8),
      s('opencode:docs', 'opencode', 'Write the API reference', 'docs', 'open', 12),
      s('claude:h1', 'claude', 'Why is the build slow?', 'web-app', 'history', 300),
      s('codex:h2', 'codex', 'Ship the onboarding emails', 'growth', 'history', 1500),
      s('claude:h3', 'claude', 'Set up CI for the monorepo', 'platform', 'history', 2900),
      s('gemini:h4', 'gemini', 'Compare three charting libraries', 'dashboard', 'history', 4400),
      s('codex:h5', 'codex', 'Migrate the users table to Postgres 17', 'orders-api', 'history', 7300),
      s('claude:h6', 'claude', 'Draft the launch blog post', 'blog', 'history', 9000),
    ];
    const exchanges = [
      { id:'ex2', from:'opencode:docs', to:'codex:api', kind:'ask', status:'waiting', message:'What are the query parameters for GET /orders now?', reply:'', error:'', createdAt:ago(0.4), answeredAt:null, taskId:'tx2' },
      { id:'ex1', from:'claude:web', to:'codex:api', kind:'ask', status:'answered', message:'Which port does the orders API listen on, and does it need an auth header?', reply:'Port 4378. Every request needs the X-Shop-Key header. I added it to the README.', error:'', createdAt:ago(2), answeredAt:ago(1.5), taskId:'tx1' },
      { id:'ex0', from:'claude:web', to:'codex:api', kind:'intro', status:'answered', message:'Agree on the checkout API shape before you change the client.', reply:'', error:'', createdAt:ago(6), answeredAt:ago(5), taskId:'tx0' },
    ];
    const tasks = [
      { id:'t1', title:'Make the checkout page load faster', status:'running', harness:'claude', sessionId:'claude:web', cwd:`${HOME}/web-app`, createdAt:ago(4), updatedAt:ago(0), delivery:'terminal', model:'opus', modelSource:'auto', routeSource:'auto', error:'' },
      { id:'t2', title:'Make the header sticky and add our opening hours', status:'completed', harness:'claude', sessionId:'claude:bakery', cwd:`${HOME}/bakery-site`, createdAt:ago(5), updatedAt:ago(3), delivery:'terminal', model:'', modelSource:'session', routeSource:'selected', error:'' },
      { id:'t3', title:'Add pagination to the orders API', status:'running', harness:'codex', sessionId:'codex:api', cwd:`${HOME}/orders-api`, createdAt:ago(9), updatedAt:ago(1), delivery:'terminal', model:'gpt-6-sol', modelSource:'auto', routeSource:'auto', error:'' },
    ];
    return { now, ago, sessions, exchanges, tasks, approved:false, sent:null, uploads:0 };
  },

  messages(state, id) {
    const { ago } = state;
    const m = (role, text, minutes) => ({ role, text, at:ago(minutes) });
    if (id === 'claude:bakery') return [
      m('user', 'Build a landing page for my bakery, Rise Bakery. Warm colours, today’s specials and an order-for-pickup button.', 14),
      m('assistant', 'Done. I built **index.html** for Rise Bakery:\n\n- A hero with today’s specials\n- An order-for-pickup form\n- A map to the shop\n\nI saved a screenshot as landing.png and a short walkthrough as preview.mp4.', 11),
      m('user', 'Make the header sticky and add our opening hours', 5),
      m('assistant', 'Updated **index.html**:\n\n- Sticky header with your logo\n- Opening hours: **Tue–Sun, 7am–3pm**\n- Checked it at phone width\n\nNew screenshot: landing.png', 3),
    ];
    if (id === 'codex:api') return [
      m('user', 'Add pagination to the orders API', 9),
      m('assistant', 'Added `cursor` and `limit` to **GET /orders**, with a default page size of 50. Tests pass (42).', 6),
      m('user', `${MARK}. It is the Claude session working on web-app ("Make the checkout page load faster"):\n\nWhich port does the orders API listen on, and does it need an auth header?\n\nAnswer in your normal reply; Shed passes your reply back to it.`, 2),
      m('assistant', 'Port **4378**. Every request needs the `X-Shop-Key` header. I added it to the README.', 1.5),
    ];
    if (id === 'claude:web') return [
      m('user', 'Make the checkout page load faster', 4),
      m('assistant', 'The checkout waits on three API calls in a row. I’ll batch them, but first I asked the **orders-api** session which port and headers it expects.\n\nIt says port 4378 with an `X-Shop-Key` header. Updating the client now.', 1),
    ];
    if (id === 'claude:mobile') return [
      m('user', 'Fix the flaky login test', 3),
      m('assistant', 'The test races the session cookie. Waiting for the cookie before the redirect should fix it.', 1),
    ];
    const session = state.sessions.find(s => s.id === id);
    return session ? [m('user', session.title, 20), m('assistant', 'On it.', 19)] : [];
  },

  terminal(state) {
    if (state.approved) return { tty:'/dev/ttys006', menu:null, text:[
      '⏺ The test races the session cookie. Waiting for the',
      '  cookie before the redirect should fix it.', '',
      '⏺ Update(tests/login.test.js)',
      '  ⎿  Updated tests/login.test.js with 4 additions and 1 removal', '',
      '⏺ Bash(npm test -- login)',
      '  ⎿  PASS tests/login.test.js (14 tests)', '',
      '⏺ The login test is stable now: 14 passed, 20 runs in a row.', '',
      '──────────────────────────────────────────',
      '❯ ',
      '──────────────────────────────────────────',
      '  ⏵⏵ accept edits on · ctx 18%',
    ].join('\n') };
    return { tty:'/dev/ttys006', text:[
      '⏺ The test races the session cookie. Waiting for the',
      '  cookie before the redirect should fix it.', '',
      '⏺ Update(tests/login.test.js)', '',
      '╭──────────────────────────────────────────╮',
      '│ Edit file                                │',
      '│ tests/login.test.js                      │',
      '│  12   await page.click("#sign-in");      │',
      '│  13 - expect(page.url()).toBe("/home");  │',
      '│  13 + await page.waitForResponse(/auth/);│',
      '│  14 + expect(page.url()).toBe("/home");  │',
      '╰──────────────────────────────────────────╯',
      ' Do you want to make this edit to login.test.js?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits during this session',
      '   3. No, and tell Claude what to do differently',
    ].join('\n'), menu:{ options:['1. Yes', '2. Yes, allow all edits during this session', '3. No, and tell Claude what to do differently'], current:0 } };
  },

  files(state, id) {
    const { ago } = state;
    if (id !== 'claude:bakery') return { root:'project', files:[] };
    return { root:'bakery-site', files:[
      { path:'out/preview.mp4', size:1254000, modifiedAt:ago(3), kind:'video' },
      { path:'out/landing.png', size:246000, modifiedAt:ago(3), kind:'image' },
      { path:'docs/menu.pdf', size:96000, modifiedAt:ago(40), kind:'pdf' },
    ] };
  },

  respond(state, method, p, q, body) {
    const ok = value => ({ body:value });
    const live = state.sessions;
    if (p === '/api/events') return 'events';
    if (p === '/api/me') return ok({ ok:true, local:false, lanEnabled:false, pendingDevices:[], phoneConnectedAt:state.ago(60 * 24 * 10), available:{ codex:true, claude:true, gemini:true, pi:true, opencode:true }, laya:{ ready:true, state:'ready', model:'laya', error:'' }, hostname:'Mayas-MacBook-Pro', phoneUrl:'', remoteUrl:'https://quiet-river-tunnel.trycloudflare.com' });
    if (p === '/api/auth/status') return ok({ passwordConfigured:true, canSetup:false });
    if (p === '/api/harness-health') return ok({ harnesses:Object.fromEntries(['codex', 'claude', 'gemini', 'pi', 'opencode'].map(h => [h, { installed:true, state:'ready', detail:'Ready', checkedAt:new Date().toISOString() }])) });
    if (p === '/api/models') return ok(models);
    if (p === '/api/settings') return ok({ laya:{ ready:true, state:'ready', model:'laya', error:'' }, local:false });
    if (p === '/api/connect') return ok({ url:'https://quiet-river-tunnel.trycloudflare.com', link:'https://quiet-river-tunnel.trycloudflare.com', secure:true, qr:'' });
    if (p === '/api/devices') return ok({ devices:[{ id:'d1', name:'iPhone · Safari', status:'approved', createdAt:state.ago(14400), lastSeenAt:state.ago(0), lastIp:'—', local:false, current:true }, { id:'d2', name:'This Mac · Chrome', status:'approved', createdAt:state.ago(20000), lastSeenAt:state.ago(30), lastIp:'—', local:true, current:false }] });
    if (p === '/api/pro') return ok({ active:false, domain:'shed.link', canChange:false });
    if (p === '/api/push') return ok({ publicKey:'BEPuJejDfeI48lzHBEeaHUiP73kyGxJMIm4XDSa9hl99a88oVanhF3hJGHMceaON0K435na3SvRsj8QyEEOIYhg', subscribed:true, devices:1, prefs:{ finished:true, asking:true } });
    if (p === '/api/share/settings') return ok({ keys:[{ id:'k1', name:'Send to Shed · iPhone', createdAt:state.ago(2000), lastUsedAt:state.ago(40), uses:12 }], cookiesBrowser:'', browsers:['', 'safari', 'chrome'], base:'https://quiet-river-tunnel.trycloudflare.com' });
    if (p === '/api/share/shortcut') return ok({ code:'demo', url:'https://quiet-river-tunnel.trycloudflare.com/api/share/download/demo' });
    if (p === '/api/autoclose') return ok({ prefs:{ enabled:true, hours:12 } });
    if (p === '/api/uploads' && method === 'POST') { state.uploads += 1; return { status:201, body:{ id:`u${state.uploads}`, name:['checkout-bug.png', 'spec.pdf', 'repro.mov'][state.uploads - 1] || 'file', size:[412000, 1126400, 3145728][state.uploads - 1] || 1000 } }; }
    if (p === '/api/sessions') return ok({ sessions:live, v:'demo' });
    if (p === '/api/tasks' && method === 'GET') return ok({ tasks:state.tasks, exchanges:state.exchanges, v:`demo${state.tasks.length}` });
    if (p === '/api/tasks' && method === 'POST') {
      const input = JSON.parse(body || '{}');
      const task = { id:'t-new', prompt:input.prompt, title:input.prompt, status:'running', harness:'claude', sessionId:null, cwd:`${HOME}/mobile-app`, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), delivery:'terminal', tty:'/dev/ttys012', permissions:'default', model:'opus', modelSource:'auto', modelReason:'A tricky, flaky test needs careful reasoning, so Opus.', routeSource:'auto', routeReason:'Picked Claude Code: debugging a test in mobile-app, where Claude has been working.', output:'Opened a new Terminal window on the Mac (ttys012). Claude will ask there before using tools; answer from the Terminal view.', error:'' };
      state.tasks = [task, ...state.tasks];
      return { status:201, body:{ task } };
    }
    if (p.startsWith('/api/tasks/')) return ok({ task:state.tasks.find(t => t.id === decodeURIComponent(p.split('/')[3])) || state.tasks[0], v:'demo' });
    if (p === '/api/followup-preview') return ok({ route:{ harness:'claude', handoff:false, reason:'Stays in this session.', source:'auto', model:'', modelSource:'session' } });
    if (p === '/api/exchanges/introduce') return { status:201, body:{ exchange:state.exchanges[2] } };
    const match = p.match(/^\/api\/sessions\/([^/]+)(?:\/(terminal|files|file|end|permissions))?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const session = live.find(x => x.id === id);
      if (match[2] === 'terminal') return method === 'POST' ? (state.approved = true, ok({ ok:true })) : ok({ ...demo.terminal(state), v:state.approved ? 'b' : 'a' });
      if (match[2] === 'files') return ok(demo.files(state, id));
      if (match[2] === 'file') return 'landing';
      if (!session) return { status:404, body:{ error:'Session not found.' } };
      return ok({ session:{ ...session, canEnd:session.liveState !== 'history' }, messages:demo.messages(state, id), v:`demo-${id}` });
    }
    return ok({ ok:true });
  },
};
