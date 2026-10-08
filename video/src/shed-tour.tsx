import React, {useEffect, useState} from 'react';
import {AbsoluteFill, Img, Sequence, continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';

// "What is Shed": a 62-second tour in the same night palette, fonts and pixel sprites as the Shed app and site.
export const TOUR_FRAMES = 1860;

const C = {
  night: '#131b17', raised: '#1a241f', line: '#2b3a32', cream: '#efe6d4', muted: '#a6b0a3',
  mint: '#7ee2c0', roof: '#d9774f', paper: '#f6efe2', ink: '#262520', term: '#0d1210',
};
const F = {
  display: "'Bricolage Grotesque', sans-serif",
  body: "'IBM Plex Sans', sans-serif",
  mono: "'IBM Plex Mono', monospace",
  pixel: "'Silkscreen', monospace",
};

// ---------- fonts ----------
const FONTS: [string, string][] = [
  ['Bricolage Grotesque', 'fonts/BricolageGrotesque.woff2'],
  ['IBM Plex Sans', 'fonts/IBMPlexSans.woff2'],
  ['IBM Plex Mono', 'fonts/IBMPlexMono.woff2'],
  ['Silkscreen', 'fonts/Silkscreen.woff2'],
];
const useFonts = () => {
  const [handle] = useState(() => delayRender('fonts'));
  useEffect(() => {
    Promise.all(FONTS.map(([family, file]) => new FontFace(family, `url(${staticFile(file)})`).load().then(face => document.fonts.add(face))))
      .then(() => continueRender(handle))
      .catch(() => continueRender(handle));
  }, [handle]);
};

// ---------- pixel sprites (shared with the app and site) ----------
type Sprite = {colors: Record<string, string | [string, string]>; rows: string[]};
const SPRITES: Record<string, Sprite> = {
  claude: {colors: {B: '#da7758', E: '#1d1a17'}, rows: ['................', '...BBBBBBBBBB...', '...BBBBBBBBBB...', '...BBEBBBBEBB...', '...BBEBBBBEBB...', '.BBBBBBBBBBBBBB.', '.BBBBBBBBBBBBBB.', '...BBBBBBBBBB...', '...BBBBBBBBBB...', '....B.B..B.B....', '....B.B..B.B....']},
  codex: {colors: {B: '#2d2f33', E: '#7ee2c0', D: '#7ee2c0', H: '#10a37f', A: '#8e8ea0'}, rows: ['.......H........', '.......A........', '...BBBBBBBBBB...', '..BBBBBBBBBBBB..', '..BBBEBBBBEBBB..', '..BBBEBBBBEBBB..', '..BBBBBBBBBBBB..', '..BBBBDBBDBBBB..', '...BBBBDDBBBB...', '.....BB..BB.....', '.....BB..BB.....']},
  gemini: {colors: {B: ['#4c8df6', '#8f6cf6'], E: '#ffffff'}, rows: ['.......BB.......', '......BBBB......', '.....BBBBBB.....', '...BBBBBBBBBB...', '.BBBBEBBBBEBBBB.', 'BBBBBEBBBBEBBBBB', '.BBBBBBBBBBBBBB.', '...BBBBBBBBBB...', '.....BBBBBB.....', '......BBBB......', '.......BB.......']},
  opencode: {colors: {B: '#2b2f33', D: '#4d5357', G: '#3ddc97', E: '#3ddc97'}, rows: ['..BBBBBBBBBBBB..', '..BDDDDDDDDDDB..', '..BDGDDDDDDDDB..', '..BDDGDDDDDDDB..', '..BDGDDEEEDDDB..', '..BDDDDDDDDDDB..', '..BBBBBBBBBBBB..', '......BBBB......', '....BBBBBBBB....', '................', '................']},
  pi: {colors: {B: '#8a8579', E: '#1d1a17', H: '#b5afa2'}, rows: ['................', '.....BBBBBB.....', '...BBBBBBBBBB...', '..BBHBBBBBBBBB..', '..BBBEBBBBEBBB..', '.BBBBEBBBBEBBBB.', '.BBBBBBBBBBBBBB.', '.BBBBBBBBBBBBBB.', '..BBBBBBBBBBBB..', '...BB......BB...', '................']},
};
const SHED: Sprite = {colors: {R: '#d9774f', L: '#a6573d', W: '#f6eedd', P: '#e7dac2', T: '#8a5a3c', D: '#1e1c19', E: '#7ee2c0', A: '#b9ae9c', M: '#7ee2c0', S: '#5fae92'}, rows: [
  '..........S.M.S.', '.......RRS..A..S', '......RRRR..A...', '.....RRRRRR.A...', '....RRRRRRRRA...', '...RRRRRRRRRR...', '..RRRRRRRRRRRR..', '.LLLLLLLLLLLLLL.',
  '..WPWPWPWPWPWP..', '..WPTTTTTTTTWP..', '..WPTDDDDDDTWP..', '..WPTDEDDEDTWP..', '..WPTDDDDDDTWP..', '..WPTDDDDDDTWP..', '..WPTDDDDDDTWP..']};

const mix = (a: string, b: string, t: number) => {
  const p = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
};
const Pixels: React.FC<{sprite: Sprite; x?: number; y?: number; rowsShown?: number; blink?: boolean; beaconOn?: boolean}> = ({sprite, x = 0, y = 0, rowsShown = 99, blink = false, beaconOn = true}) => {
  const out: React.ReactNode[] = [];
  const total = sprite.rows.length;
  sprite.rows.forEach((row, ry) => {
    if (total - ry > rowsShown) return; // builds from the floor up
    for (let rx = 0; rx < row.length;) {
      const k = row[rx];
      if (k === '.') { rx++; continue; }
      let e = rx; while (row[e + 1] === k) e++;
      const raw = sprite.colors[k];
      const fill = Array.isArray(raw) ? mix(raw[0], raw[1], ry / (total - 1)) : raw;
      const hidden = (k === 'E' && blink) || (k === 'M' && !beaconOn);
      out.push(<rect key={`${ry}-${rx}`} x={x + rx} y={y + ry + (k === 'E' && blink ? 0.4 : 0)} width={e - rx + 1} height={k === 'E' && blink ? 0.2 : 1} fill={hidden && k === 'M' ? '#2f5a4a' : fill} />);
      rx = e + 1;
    }
  });
  return <>{out}</>;
};

type Mood = 'working' | 'open' | 'asking';
const Agent: React.FC<{name: string; mood: Mood; size: number; frame: number; seed?: number}> = ({name, mood, size, frame, seed = 0}) => {
  const sprite = SPRITES[name];
  const raw = sprite.colors.B;
  const body = Array.isArray(raw) ? raw[1] : raw;
  const hopPeriod = mood === 'working' ? 15 : mood === 'asking' ? 27 : 72;
  const hop = Math.floor((frame + seed * 7) / hopPeriod) % 2 === 1 ? -1 : 0;
  const blink = (frame + seed * 41) % 140 < 5;
  const tapL = Math.floor(frame / 4) % 2 === 0 ? -1 : 0;
  const tapR = Math.floor(frame / 4) % 2 === 1 ? -1 : 0;
  const steamA = Math.floor(frame / 18) % 3, steamB = Math.floor((frame + 27) / 18) % 3;
  const wave = Math.floor(frame / 14) % 2 === 1 ? 8 : 0;
  return (
    <svg viewBox="0 0 24 20" width={size} height={size * 20 / 24} shapeRendering="crispEdges" style={{overflow: 'visible', display: 'block'}}>
      <rect x={5} y={18} width={14} height={1} fill="#00000035" />
      <g transform={`translate(0 ${hop})`}><Pixels sprite={sprite} x={4} y={4} blink={blink} /></g>
      {mood === 'working' && <>
        <rect x={7} y={12} width={10} height={5} fill="#2c2b27" /><rect x={8} y={13} width={8} height={3} fill={Math.floor(frame / 9) % 3 === 0 ? '#c9f2d6' : '#a6e8bd'} />
        {Math.floor(frame / 12) % 2 === 0 && <rect x={9} y={14} width={2} height={1} fill="#2c2b27" />}
        <rect x={5} y={17} width={14} height={1} fill="#57534a" />
        <rect x={6} y={16 + tapL} width={2} height={1} fill={body} /><rect x={16} y={16 + tapR} width={2} height={1} fill={body} />
      </>}
      {mood === 'open' && <>
        <rect x={19} y={14} width={3} height={4} fill="#d8ccb6" /><rect x={19} y={14} width={3} height={1} fill="#8a6a4f" /><rect x={22} y={15} width={1} height={2} fill="#d8ccb6" />
        {steamA < 2 && <rect x={20} y={12 - steamA} width={1} height={1} fill="#b3ab9c" />}
        {steamB < 2 && <rect x={21} y={11 - steamB} width={1} height={1} fill="#b3ab9c" />}
      </>}
      {mood === 'asking' && <g transform={`rotate(${wave} 20 7)`}>
        <rect x={18} y={0} width={5} height={6} fill="#c2603f" /><rect x={17} y={1} width={7} height={4} fill="#c2603f" /><rect x={18} y={6} width={1} height={1} fill="#c2603f" />
        <rect x={20} y={1} width={1} height={2} fill="#fff" /><rect x={20} y={4} width={1} height={1} fill="#fff" />
      </g>}
    </svg>
  );
};

const ShedLogo: React.FC<{size: number; frame: number; rowsShown?: number; tile?: boolean}> = ({size, frame, rowsShown = 99, tile = true}) => (
  <svg viewBox="0 0 20 20" width={size} height={size} shapeRendering="crispEdges" style={{display: 'block', overflow: 'visible'}}>
    {tile && <rect width={20} height={20} rx={4} fill="#374238" />}
    <Pixels sprite={SHED} x={2} y={1} rowsShown={rowsShown} beaconOn={Math.floor(frame / 20) % 2 === 0} />
    {rowsShown >= 15 && <rect x={3} y={16} width={14} height={1} fill="#2a3229" />}
  </svg>
);

// ---------- helpers ----------
const ease = (frame: number, from: number, to: number, a = 0, b = 1) => interpolate(frame, [from, to], [a, b], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
const typed = (text: string, frame: number, start: number, cps = 1.4) => text.slice(0, Math.max(0, Math.floor((frame - start) * cps)));
const Rise: React.FC<{frame: number; at: number; children: React.ReactNode; style?: React.CSSProperties}> = ({frame, at, children, style}) => {
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - at, fps, config: {damping: 200}});
  return <div style={{opacity: s, transform: `translateY(${(1 - s) * 24}px)`, ...style}}>{children}</div>;
};
const Eyebrow: React.FC<{children: React.ReactNode; color?: string}> = ({children, color = C.mint}) => (
  <div style={{fontFamily: F.pixel, fontSize: 22, letterSpacing: '.08em', textTransform: 'uppercase', color}}>{children}</div>
);
const Headline: React.FC<{children: React.ReactNode; size?: number}> = ({children, size = 76}) => (
  <div style={{fontFamily: F.display, fontWeight: 800, fontSize: size, lineHeight: 1.02, letterSpacing: '-0.03em', color: C.cream}}>{children}</div>
);
const Stars: React.FC<{frame: number}> = ({frame}) => (
  <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
    {Array.from({length: 46}, (_, i) => {
      const x = (i * 397) % 1920, y = (i * 211) % 620;
      const on = (Math.floor(frame / 22) + i) % 7 !== 0;
      return <rect key={i} x={x} y={y} width={4} height={4} fill={C.cream} opacity={on ? 0.16 : 0.05} />;
    })}
  </svg>
);

// ---------- devices ----------
const TerminalWindow: React.FC<{title: string; children: React.ReactNode; style?: React.CSSProperties; fontSize?: number}> = ({title, children, style, fontSize = 22}) => (
  <div style={{background: C.term, border: `2px solid ${C.line}`, borderRadius: 16, overflow: 'hidden', boxShadow: '0 40px 90px #0009', ...style}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 9, padding: '14px 18px', borderBottom: `2px solid ${C.line}`, fontFamily: F.mono, fontSize: 17, color: C.muted}}>
      <i style={{width: 13, height: 13, borderRadius: '50%', background: '#3a4740'}} /><i style={{width: 13, height: 13, borderRadius: '50%', background: '#3a4740'}} /><i style={{width: 13, height: 13, borderRadius: '50%', background: '#3a4740'}} />
      <span style={{marginLeft: 10}}>{title}</span>
    </div>
    <div style={{padding: '18px 22px', fontFamily: F.mono, fontSize, lineHeight: 1.55, color: '#d9e4dc', whiteSpace: 'pre-wrap'}}>{children}</div>
  </div>
);
const Caret: React.FC<{frame: number}> = ({frame}) => <span style={{display: 'inline-block', width: 11, height: 22, background: C.mint, verticalAlign: -3, opacity: Math.floor(frame / 15) % 2 ? 0 : 1}} />;

const PhoneCard: React.FC<{agent: string; mood: Mood; project: string; frame: number; seed?: number}> = ({agent, mood, project, frame, seed}) => {
  const status = {working: ['Typing away', '#4e7a62'], open: ['Waiting for you', '#8a8579'], asking: ['Needs your OK', '#b25b3d']}[mood];
  return (
    <div style={{background: '#fffdf8', border: `2px solid ${mood === 'asking' ? '#e7b9a6' : '#e3dccf'}`, borderRadius: 20, overflow: 'hidden', boxShadow: mood === 'asking' ? '0 0 0 5px #f5e7df' : 'none'}}>
      <div style={{height: 132, display: 'grid', placeItems: 'center', background: 'linear-gradient(#fbf9f4, #f1ece2)', borderBottom: '2px dashed #e3dccf'}}><Agent name={agent} mood={mood} size={150} frame={frame} seed={seed} /></div>
      <div style={{padding: '12px 16px 16px'}}>
        <div style={{fontFamily: F.body, fontWeight: 500, fontSize: 22, color: C.ink}}>{project}</div>
        <div style={{fontFamily: F.mono, fontSize: 17, color: status[1], marginTop: 2}}>● {status[0]}</div>
      </div>
    </div>
  );
};
const Phone: React.FC<{children: React.ReactNode; style?: React.CSSProperties; scale?: number}> = ({children, style, scale = 1}) => (
  <div style={{position: 'relative', width: 430, height: 880, borderRadius: 62, background: C.paper, padding: 22, boxShadow: '0 50px 110px #000b, 0 0 0 16px #0b0f0d, 0 0 0 18px #33443a', transform: `scale(${scale})`, ...style}}>
    <div style={{display: 'flex', justifyContent: 'space-between', fontFamily: F.body, fontWeight: 500, fontSize: 19, color: '#6d6a62', padding: '6px 14px 14px'}}><span>9:41</span><span>Shed</span></div>
    {children}
  </div>
);
const MessageBar: React.FC<{text: string; pressed?: boolean; placeholder?: boolean}> = ({text, pressed, placeholder}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: 10, background: '#fffdf8', border: '2px solid #ddd3c6', borderRadius: 34, padding: '9px 9px 9px 16px', fontFamily: F.body, fontSize: 21}}>
    <span style={{border: '2px solid #e1d9cb', borderRadius: 20, padding: '4px 12px', fontSize: 18, color: C.ink, background: '#f1efe9'}}>✦ Auto</span>
    <span style={{flex: 1, color: placeholder ? '#9a958b' : C.ink, whiteSpace: 'nowrap', overflow: 'hidden'}}>{text}</span>
    <span style={{width: 48, height: 48, borderRadius: '50%', background: '#a6573d', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 24, transform: `scale(${pressed ? 0.86 : 1})`}}>↑</span>
  </div>
);

// ---------- scenes ----------
const Intro: React.FC = () => {
  const f = useCurrentFrame();
  const rows = Math.floor(ease(f, 6, 54, 0, 15));
  return (
    <AbsoluteFill style={{background: C.night}}>
      <Stars frame={f} />
      <AbsoluteFill style={{display: 'grid', placeItems: 'center'}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 70}}>
          <div style={{transform: `scale(${ease(f, 0, 50, 0.92, 1)})`}}><ShedLogo size={380} frame={f} rowsShown={rows} tile={false} /></div>
          <div style={{display: 'grid', gap: 22}}>
            <Rise frame={f} at={58}><div style={{fontFamily: F.display, fontWeight: 800, fontSize: 170, letterSpacing: '-0.04em', lineHeight: 0.9, color: C.cream}}>Shed</div></Rise>
            <Rise frame={f} at={80}><div style={{fontFamily: F.display, fontWeight: 800, fontSize: 56, letterSpacing: '-0.02em', color: C.roof, lineHeight: 1.05}}>Your coding agents,<br />in your pocket.</div></Rise>
            <Rise frame={f} at={104}><Eyebrow>Powered by Laya</Eyebrow></Rise>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const LINES: Record<string, string[]> = {
  claude: ['❯ Refactor the auth middleware', '⏺ Reading src/auth/session.ts', '⏺ Splitting token checks into', '  verifyToken() and refresh()', '  Updated 3 files'],
  codex: ['› Add pagination to /api/orders', '• Ran npm test (42 passed)', '• Added cursor + limit params', '• Updated OpenAPI spec', '  Worked for 2m 10s'],
  gemini: ['> Summarise today\'s error logs', '✦ 3 recurring errors found', '✦ Timeout in payment webhook', '✦ Drafting a fix plan…', ''],
};
const Desk: React.FC = () => {
  const f = useCurrentFrame();
  const away = ease(f, 150, 210);
  const firstLine = 1 - ease(f, 140, 160), secondLine = ease(f, 166, 188);
  return (
    <AbsoluteFill style={{background: C.night}}>
      <Stars frame={f} />
      <div style={{position: 'absolute', left: 120, right: 120, top: 92, display: 'grid', gap: 14}}>
        <Rise frame={f} at={4}><Eyebrow>On your Mac</Eyebrow></Rise>
        <div style={{position: 'relative', height: 90}}>
          <div style={{position: 'absolute', left: 0, right: 0, opacity: firstLine}}><Rise frame={f} at={8}><Headline>Your agents work in terminals on your Mac.</Headline></Rise></div>
          <div style={{position: 'absolute', left: 0, right: 0, opacity: secondLine, transform: `translateY(${(1 - secondLine) * 20}px)`}}><Headline>But you’re not always at your desk.</Headline></div>
        </div>
      </div>
      <div style={{position: 'absolute', left: 120, right: 120, top: 270, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 30, opacity: 1 - away * 0.65, filter: `blur(${away * 3}px)`, transform: `scale(${1 - away * 0.04})`}}>
        {(['claude', 'codex', 'gemini'] as const).map((name, i) => (
          <Rise key={name} frame={f} at={20 + i * 10}>
            <TerminalWindow title={`ttys00${3 + i} · ${['api-server', 'shop-backend', 'ops'][i]}`} fontSize={24}>
              <div style={{display: 'flex', justifyContent: 'center', margin: '10px 0 24px'}}><Agent name={name} mood="working" size={230} frame={f} seed={i} /></div>
              {LINES[name].map((line, li) => {
                const start = 40 + li * 26 + i * 8;
                return <div key={li} style={{color: li === 0 ? C.cream : li === 4 ? '#7d8b82' : C.mint, minHeight: 38}}>{typed(line, f, start, 1.6)}</div>;
              })}
            </TerminalWindow>
          </Rise>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const LAYA_OPTIONS = [['Claude Code · Opus', 0.82, true], ['Codex · gpt-6-astra', 0.12, false], ['Gemini · 2.5 Pro', 0.06, false]] as const;
const PhoneScene: React.FC = () => {
  const f = useCurrentFrame();
  const message = 'Fix the flaky login test';
  const text = typed(message, f, 50, 0.45);
  const sent = f >= 150;
  return (
    <AbsoluteFill style={{background: C.night}}>
      <Stars frame={f} />
      <div style={{position: 'absolute', left: 230, top: 100, transform: `translateY(${ease(f, 0, 24, 60, 0)}px)`, opacity: ease(f, 0, 18)}}>
        <Phone>
          <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 40, color: C.ink, margin: '4px 6px 14px', letterSpacing: '-0.02em'}}>Live sessions</div>
          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14}}>
            <PhoneCard agent="claude" mood="open" project="web-app" frame={f} />
            <PhoneCard agent="codex" mood="working" project="shop-backend" frame={f} seed={2} />
          </div>
          <div style={{marginTop: 26, fontFamily: F.body, fontSize: 19, color: '#7a766d', padding: '0 6px'}}>Pick up where you left off</div>
          <div style={{marginTop: 10, display: 'grid', gap: 10}}>
            {['Ship the onboarding emails', 'Why is the build slow?'].map(t => <div key={t} style={{background: '#fffdf8', border: '2px solid #e3dccf', borderRadius: 14, padding: '12px 16px', fontFamily: F.body, fontSize: 19, color: C.ink}}>{t}</div>)}
          </div>
          <div style={{position: 'absolute', left: 22, right: 22, bottom: 30}}><MessageBar text={sent ? 'Message Shed…' : text || 'Message Shed…'} placeholder={sent || !text} pressed={f >= 140 && f < 152} /></div>
        </Phone>
      </div>
      <div style={{position: 'absolute', left: 860, top: 150, width: 880, display: 'grid', gap: 22}}>
        <Rise frame={f} at={10}><Eyebrow>From anywhere</Eyebrow></Rise>
        <Rise frame={f} at={14}><Headline>Just message.</Headline></Rise>
        <Rise frame={f} at={24}><div style={{fontFamily: F.body, fontSize: 32, color: C.muted, lineHeight: 1.45, maxWidth: 780}}>Type what you need. Leave it on Auto, and Laya picks the agent and model on your Mac.</div></Rise>
        {sent && (
          <Rise frame={f} at={158} style={{marginTop: 26}}>
            <div style={{border: `2px solid ${C.line}`, borderRadius: 20, background: C.raised, padding: '26px 30px', display: 'grid', gap: 18}}>
              <div style={{display: 'flex', justifyContent: 'space-between', fontFamily: F.mono, fontSize: 22, color: C.mint}}><span>✦ Laya · local decision model</span><span style={{color: C.muted}}>0 tokens</span></div>
              {LAYA_OPTIONS.map(([label, score, pick], i) => {
                const w = ease(f, 175 + i * 6, 235 + i * 6, 0, score);
                return (
                  <div key={label} style={{display: 'grid', gridTemplateColumns: '330px 1fr 80px', alignItems: 'center', gap: 18, fontFamily: F.mono, fontSize: 22, color: pick && f > 250 ? C.cream : C.muted}}>
                    <span>{pick && f > 250 ? '✓ ' : '  '}{label}</span>
                    <div style={{height: 14, background: '#24302a', borderRadius: 7}}><div style={{height: 14, width: `${w * 100}%`, background: pick ? C.mint : '#4b5c52', borderRadius: 7}} /></div>
                    <span style={{textAlign: 'right'}}>{Math.round(w * 100)}%</span>
                  </div>
                );
              })}
            </div>
          </Rise>
        )}
      </div>
    </AbsoluteFill>
  );
};

const Handoff: React.FC = () => {
  const f = useCurrentFrame();
  const packet = ease(f, 6, 50);
  const arrived = f >= 50;
  const asking = f >= 168 && f < 238;
  const approved = f >= 238;
  const done = f >= 330;
  const reply = '⏺ The test races the session cookie.\n  Waiting for the cookie before the\n  redirect fixes it.';
  const mood: Mood = asking ? 'asking' : done ? 'open' : 'working';
  // packet path: phone (left) to terminal (right)
  const px = interpolate(packet, [0, 1], [560, 960]), py = interpolate(packet, [0, 0.5, 1], [640, 430, 380]);
  return (
    <AbsoluteFill style={{background: C.night}}>
      <Stars frame={f} />
      <div style={{position: 'absolute', left: 120, top: 70, display: 'grid', gap: 12, width: 1700}}>
        <Eyebrow>{asking ? 'Needs your OK' : 'Real terminal'}</Eyebrow>
        <Headline size={64}>{f < 168 ? 'It runs in the same terminal on your Mac.' : approved ? 'Approved from your phone. Work continues.' : 'When it asks, you answer from your phone.'}</Headline>
      </div>
      <div style={{position: 'absolute', left: 140, top: 290, transform: 'scale(0.82)', transformOrigin: 'top left'}}>
        <Phone>
          <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 36, color: C.ink, margin: '4px 6px 14px'}}>web-app</div>
          <PhoneCard agent="claude" mood={mood} project="Fix the flaky login test" frame={f} />
          <div style={{marginTop: 18, display: 'flex', gap: 10}}>
            {['Stop', '1', '2', 'Enter'].map(k => {
              const lit = asking && /\d/.test(k);
              const tap = k === '1' && f >= 228 && f < 240;
              return <div key={k} style={{flex: k.length > 1 ? 1.5 : 1, textAlign: 'center', padding: '16px 0', borderRadius: 14, fontFamily: F.mono, fontWeight: 500, fontSize: 24, background: lit ? '#a6573d' : '#2a2925', color: '#f3f1ea', transform: `scale(${tap ? 0.88 : 1})`, boxShadow: tap ? '0 0 0 6px #e7b9a6' : 'none'}}>{k}</div>;
            })}
          </div>
        </Phone>
      </div>
      {!arrived && <div style={{position: 'absolute', left: px, top: py, width: 22, height: 22, background: C.mint, boxShadow: `0 0 30px ${C.mint}`}} />}
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0, opacity: arrived ? 0.25 : 0.6}}><path d="M560 650 C 760 650, 800 380, 960 380" stroke={C.mint} strokeWidth={4} strokeDasharray="6 14" fill="none" /></svg>
      <div style={{position: 'absolute', left: 960, top: 300, width: 840}}>
        <TerminalWindow title="ttys003 · ~/web-app · Claude Code" fontSize={25}>
          <div style={{color: '#7d8b82'}}>✻ Claude Code · Opus · ~/web-app</div>
          <div style={{minHeight: 20}} />
          {arrived && <div style={{color: C.cream}}>{typed('❯ Fix the flaky login test', f, 52, 2.2)}</div>}
          <div style={{minHeight: 18}} />
          {f >= 72 && <div style={{color: '#d9e4dc'}}>{typed(reply, f, 72, 1.6)}</div>}
          {f >= 168 && !approved && <div style={{marginTop: 18, color: C.roof}}>  Do you want to edit login.test.js?{'\n'}  ❯ 1. Yes{'\n'}<span style={{color: '#7d8b82'}}>    2. No</span></div>}
          {approved && <div style={{marginTop: 18}}>
            <div style={{color: C.mint}}>{typed('⏺ Edited login.test.js (+4 −1)', f, 244, 2)}</div>
            {f >= 270 && <div style={{color: C.mint}}>{typed('⏺ npm test: 14 passed', f, 270, 2)}</div>}
            {f >= 300 && <div style={{color: '#d9e4dc'}}>{typed('  The login test is stable now.', f, 300, 2)}</div>}
          </div>}
          <div style={{marginTop: 14}}>❯ <Caret frame={f} /></div>
        </TerminalWindow>
      </div>
    </AbsoluteFill>
  );
};

const FEATURES = [
  {title: 'The same terminal, not a copy', body: 'Messages are typed into the Terminal tab that holds the session. Walk back to your Mac and it’s all there.', art: 'terminal'},
  {title: 'Routed on your Mac by Laya', body: 'An open-source decision model picks the harness and model. No API key, no tokens.', art: 'laya'},
  {title: 'Replies survive restarts', body: 'Claude and Codex run in Terminal windows, and Shed follows their transcripts.', art: 'restart'},
  {title: 'Bring every agent you use', body: 'Claude Code, Codex, Gemini, OpenCode and Pi, in one place.', art: 'agents'},
] as const;
const Highlights: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{background: C.night}}>
      <Stars frame={f} />
      <div style={{position: 'absolute', left: 120, top: 90, display: 'grid', gap: 12}}>
        <Rise frame={f} at={0}><Eyebrow>Built for long-running agents</Eyebrow></Rise>
        <Rise frame={f} at={6}><Headline>Everything stays on your Mac.</Headline></Rise>
      </div>
      <div style={{position: 'absolute', left: 120, right: 120, top: 330, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 28}}>
        {FEATURES.map((item, i) => (
          <Rise key={item.title} frame={f} at={20 + i * 45}>
            <div style={{border: `2px solid ${C.line}`, borderRadius: 22, background: C.raised, height: 560, overflow: 'hidden', display: 'grid', gridTemplateRows: '260px 1fr'}}>
              <div style={{display: 'grid', placeItems: 'center', background: 'linear-gradient(#1d2923, #17201b)', borderBottom: `2px dashed ${C.line}`}}>
                {item.art === 'terminal' && <div style={{fontFamily: F.mono, fontSize: 26, color: C.mint, background: C.term, border: `2px solid ${C.line}`, borderRadius: 12, padding: '18px 22px'}}>❯ Fix the flaky<br />&nbsp;&nbsp;login test<Caret frame={f} /></div>}
                {item.art === 'laya' && <div style={{fontFamily: F.pixel, fontSize: 30, color: C.mint, textAlign: 'center', lineHeight: 1.5}}>✦ Laya<br /><span style={{fontFamily: F.mono, fontSize: 24, color: C.muted}}>stay · switch · model</span></div>}
                {item.art === 'restart' && <Agent name="codex" mood={Math.floor(f / 60) % 2 ? 'open' : 'working'} size={200} frame={f} seed={3} />}
                {item.art === 'agents' && <div style={{display: 'flex', gap: 2}}>{['claude', 'codex', 'gemini', 'opencode', 'pi'].map((name, k) => <Agent key={name} name={name} mood="open" size={84} frame={f} seed={k} />)}</div>}
              </div>
              <div style={{padding: '26px 28px', display: 'grid', alignContent: 'start', gap: 12}}>
                <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 33, lineHeight: 1.12, color: C.cream, letterSpacing: '-0.01em'}}>{item.title}</div>
                <div style={{fontFamily: F.body, fontSize: 24, lineHeight: 1.45, color: C.muted}}>{item.body}</div>
              </div>
            </div>
          </Rise>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const Connect: React.FC = () => {
  const f = useCurrentFrame();
  const scan = ease(f, 40, 110);
  const end = ease(f, 165, 190);
  return (
    <AbsoluteFill style={{background: C.night}}>
      <Stars frame={f} />
      <AbsoluteFill style={{opacity: 1 - end}}>
        <div style={{position: 'absolute', left: 120, top: 100, display: 'grid', gap: 12}}>
          <Rise frame={f} at={0}><Eyebrow>Connect in seconds</Eyebrow></Rise>
          <Rise frame={f} at={6}><Headline>Scan. Sign in. Just message.</Headline></Rise>
        </div>
        <div style={{position: 'absolute', left: 160, top: 330, width: 860, height: 560, background: C.paper, borderRadius: 26, border: '14px solid #0b0f0d', boxShadow: '0 40px 90px #000a', display: 'flex', alignItems: 'center', gap: 46, padding: 50}}>
          <div style={{width: 300, height: 300, background: '#fffdf8', borderRadius: 18, padding: 14, border: '2px solid #e3dccf', position: 'relative', overflow: 'hidden'}}>
            <Img src={staticFile('qr.svg')} style={{width: '100%', height: '100%'}} />
            {f > 40 && f < 112 && <div style={{position: 'absolute', left: 0, right: 0, top: `${scan * 100}%`, height: 6, background: C.mint, boxShadow: `0 0 24px ${C.mint}`}} />}
          </div>
          <div style={{display: 'grid', gap: 14, color: C.ink}}>
            <div style={{fontFamily: F.pixel, fontSize: 18, color: '#a6573d', letterSpacing: '.06em'}}>TAKE SHED WITH YOU</div>
            <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 44, lineHeight: 1.08}}>Message your agents from your phone</div>
            <div style={{fontFamily: F.body, fontSize: 23, color: '#625f57', lineHeight: 1.45}}>Point your camera at this code and sign in with your Shed password.</div>
          </div>
        </div>
        <div style={{position: 'absolute', left: 1180, top: 200, transform: `translateX(${ease(f, 10, 40, 160, 0)}px) rotate(${ease(f, 10, 40, 8, -4)}deg) scale(0.86)`, transformOrigin: 'top left'}}>
          <Phone>
            {f < 118 ? (
              <div style={{height: 760, borderRadius: 30, background: '#111', display: 'grid', placeItems: 'center', color: '#fff', fontFamily: F.body, fontSize: 24}}>
                <div style={{width: 300, height: 300, border: `5px solid ${C.mint}`, borderRadius: 26}} />
              </div>
            ) : (
              <div style={{display: 'grid', gap: 18, paddingTop: 30, justifyItems: 'center'}}>
                <ShedLogo size={150} frame={f} />
                <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 52, color: C.ink}}>Shed</div>
                <div style={{width: '100%', marginTop: 360}}><MessageBar text={typed('Ship it', f, 130, 0.5) || 'Message Shed…'} placeholder={f < 132} /></div>
              </div>
            )}
          </Phone>
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{opacity: end, display: 'grid', placeItems: 'center'}}>
        <div style={{display: 'grid', justifyItems: 'center', gap: 34, transform: `translateY(${(1 - end) * 30}px)`}}>
          <ShedLogo size={260} frame={f} />
          <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 132, letterSpacing: '-0.04em', color: C.cream, lineHeight: 0.9}}>Shed</div>
          <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 54, color: C.roof}}>Your desk, in your pocket.</div>
          <Eyebrow>Powered by Laya · Runs on your Mac</Eyebrow>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// Scene timeline (frames at 30fps)
const SCENES: [React.FC, number, number][] = [
  [Intro, 0, 150],
  [Desk, 150, 270],
  [PhoneScene, 420, 330],
  [Handoff, 750, 400],
  [Highlights, 1150, 360],
  [Connect, 1510, 350],
];
const Fade: React.FC<{duration: number; children: React.ReactNode}> = ({duration, children}) => {
  const f = useCurrentFrame();
  const opacity = Math.min(ease(f, 0, 10), ease(f, duration - 10, duration, 1, 0));
  return <AbsoluteFill style={{opacity}}>{children}</AbsoluteFill>;
};

export const ShedTour: React.FC = () => {
  useFonts();
  return (
    <AbsoluteFill style={{background: C.night}}>
      {SCENES.map(([Scene, from, duration], i) => (
        <Sequence key={i} from={from} durationInFrames={duration}>
          <Fade duration={i === SCENES.length - 1 ? duration + 20 : duration}><Scene /></Fade>
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
