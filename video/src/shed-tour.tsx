import React, {useEffect, useState} from 'react';
import {AbsoluteFill, Img, Sequence, continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';

// "What is Shed": a 62-second tour in the same night palette, fonts and pixel sprites as the Shed app and site.
export const TOUR_FRAMES = 2400;

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
const MessageBar: React.FC<{text: string; pressed?: boolean; placeholder?: boolean; agent?: string; agentLit?: boolean}> = ({text, pressed, placeholder, agent = '✦ Auto', agentLit}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: 10, background: '#fffdf8', border: '2px solid #ddd3c6', borderRadius: 34, padding: '9px 9px 9px 16px', fontFamily: F.body, fontSize: 21}}>
    <span style={{border: `2px solid ${agentLit ? '#a6573d' : '#e1d9cb'}`, borderRadius: 20, padding: '4px 12px', fontSize: 18, color: C.ink, background: agentLit ? '#f5e7df' : '#f1efe9', whiteSpace: 'nowrap'}}>{agent}</span>
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
  const away = ease(f, 110, 160);
  const firstLine = 1 - ease(f, 100, 118), secondLine = ease(f, 124, 144);
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


// ---------- new: starting agents from the phone ----------
const DeskCard: React.FC<{agent: string; mood: Mood; project: string; harness: string; frame: number; seed?: number; pop?: number}> = ({agent, mood, project, harness, frame, seed, pop = 1}) => {
  const status = {working: ['Typing away', '#4e7a62'], open: ['Waiting for you', '#8a8579'], asking: ['Needs your OK', '#b25b3d']}[mood];
  return (
    <div style={{transform: `scale(${pop})`, opacity: Math.min(1, pop * 1.4), transformOrigin: '50% 60%', background: '#fffdf8', border: '2px solid #e3dccf', borderRadius: 18, overflow: 'hidden'}}>
      <div style={{position: 'relative', height: 108, display: 'grid', placeItems: 'center', background: 'linear-gradient(#fbf9f4, #f1ece2)', borderBottom: '2px dashed #e3dccf'}}>
        <span style={{position: 'absolute', top: 7, left: 10, fontFamily: F.mono, fontSize: 12.5, color: '#8a8579'}}>{harness}</span>
        <div style={{marginTop: 12}}><Agent name={agent} mood={mood} size={118} frame={frame} seed={seed} /></div>
      </div>
      <div style={{padding: '9px 12px 12px'}}>
        <div style={{fontFamily: F.body, fontWeight: 500, fontSize: 18, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{project}</div>
        <div style={{fontFamily: F.mono, fontSize: 14, color: status[1], marginTop: 2}}>● {status[0]}</div>
      </div>
    </div>
  );
};
const MiniTerminal: React.FC<{title: string; lines: string[]; frame: number; at: number}> = ({title, lines, frame, at}) => {
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - at, fps, config: {damping: 16}});
  if (frame < at) return null;
  return (
    <div style={{transform: `translateY(${(1 - s) * 40}px) scale(${0.9 + s * 0.1})`, opacity: s, background: C.term, border: `2px solid ${C.line}`, borderRadius: 12, overflow: 'hidden', boxShadow: '0 20px 50px #0008'}}>
      <div style={{display: 'flex', gap: 7, alignItems: 'center', padding: '8px 12px', borderBottom: `2px solid ${C.line}`, fontFamily: F.mono, fontSize: 14, color: C.muted}}>
        <i style={{width: 10, height: 10, borderRadius: '50%', background: '#3a4740'}} /><i style={{width: 10, height: 10, borderRadius: '50%', background: '#3a4740'}} /><i style={{width: 10, height: 10, borderRadius: '50%', background: '#3a4740'}} /><span style={{marginLeft: 6}}>{title}</span>
      </div>
      <div style={{padding: '10px 14px', fontFamily: F.mono, fontSize: 17, lineHeight: 1.5, color: '#d9e4dc', whiteSpace: 'pre-wrap', minHeight: 96}}>
        {lines.map((line, i) => <div key={i} style={{color: i === 0 ? C.cream : C.mint}}>{typed(line, frame, at + 12 + i * 22, 2)}</div>)}
      </div>
    </div>
  );
};
const ADD_OPTIONS = [['Claude Code · Sonnet', 0.78, true], ['Codex · gpt-6-sol', 0.15, false], ['Gemini · 2.5 Pro', 0.07, false]] as const;
const AddAgents: React.FC = () => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const first = 'Build a landing page for my bakery';
  const second = 'Add pagination to the orders API';
  const firstSent = f >= 104, secondSent = f >= 318;
  const pop1 = firstSent && f >= 205 ? spring({frame: f - 205, fps, config: {damping: 11}}) : 0;
  const pop2 = secondSent && f >= 340 ? spring({frame: f - 340, fps, config: {damping: 11}}) : 0;
  const barText = f < 104 ? typed(first, f, 22, 0.5) : f >= 236 && f < 318 ? typed(second, f, 252, 0.6) : '';
  const picker = f >= 236 && f < 330 ? 'Codex' : '✦ Auto';
  const count = 2 + (pop1 > 0.2 ? 1 : 0) + (pop2 > 0.2 ? 1 : 0);
  const line = f < 196 ? 0 : f < 236 ? 1 : f < 330 ? 2 : 3;
  const headlines = ['Start an agent from your phone.', 'It joins your desk on the Mac.', 'Or pick the agent yourself.', 'Each one runs in its own Terminal.'];
  const cards: React.ReactNode[] = [];
  if (pop2 > 0) cards.push(<DeskCard key="orders" agent="codex" mood="working" project="orders-api" harness="Codex" frame={f} seed={4} pop={pop2} />);
  if (pop1 > 0) cards.push(<DeskCard key="bakery" agent="claude" mood="working" project="bakery-site" harness="Claude Code" frame={f} seed={3} pop={pop1} />);
  cards.push(<DeskCard key="web" agent="claude" mood="open" project="web-app" harness="Claude Code" frame={f} seed={1} />);
  cards.push(<DeskCard key="shop" agent="codex" mood="working" project="shop-backend" harness="Codex" frame={f} seed={2} />);
  return (
    <AbsoluteFill style={{background: C.night}}>
      <Stars frame={f} />
      <div style={{position: 'absolute', left: 200, top: 90, transform: `translateY(${ease(f, 0, 22, 50, 0)}px)`, opacity: ease(f, 0, 16)}}>
        <Phone>
          <div style={{display: 'flex', alignItems: 'center', gap: 10, margin: '2px 6px 12px'}}>
            <span style={{fontFamily: F.display, fontWeight: 800, fontSize: 36, color: C.ink, letterSpacing: '-0.02em'}}>Live sessions</span>
            <span style={{fontFamily: F.mono, fontSize: 18, color: '#466e58', background: '#e5efe9', borderRadius: 8, padding: '2px 9px'}}>{count}</span>
          </div>
          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>{cards.slice(0, 4)}</div>
          <div style={{marginTop: 20, fontFamily: F.display, fontWeight: 700, fontSize: 24, color: C.ink, padding: '0 6px'}}>Pick up where you left off</div>
          <div style={{marginTop: 8, display: 'grid', gap: 8}}>
            {[['✳', 'Why is the build slow?', 'web-app'], ['◇', 'Ship the onboarding emails', 'growth']].slice(0, count >= 4 ? 1 : 2).map(([icon, title, project]) => (
              <div key={title} style={{display: 'flex', alignItems: 'center', gap: 12, background: '#fffdf8', border: '2px solid #e3dccf', borderRadius: 14, padding: '10px 14px'}}>
                <span style={{width: 34, height: 34, borderRadius: 9, background: '#f5e7df', color: '#c2603f', display: 'grid', placeItems: 'center'}}>{icon}</span>
                <div><div style={{fontFamily: F.body, fontWeight: 500, fontSize: 17, color: C.ink}}>{title}</div><div style={{fontFamily: F.mono, fontSize: 13, color: '#8a8579'}}>{project}</div></div>
              </div>
            ))}
          </div>
          <div style={{position: 'absolute', left: 22, right: 22, bottom: 30}}>
            <MessageBar text={barText || 'Message Shed…'} placeholder={!barText} pressed={(f >= 96 && f < 106) || (f >= 310 && f < 320)} agent={picker} agentLit={picker !== '✦ Auto'} />
          </div>
          {f >= 236 && f < 252 && <div style={{position: 'absolute', left: 30, bottom: 96, background: '#fffdf8', border: '2px solid #ddd3c6', borderRadius: 14, boxShadow: '0 12px 30px #0002', fontFamily: F.body, fontSize: 19, color: C.ink, overflow: 'hidden'}}>
            {['✦ Auto', 'Claude Code', 'Codex', 'Gemini'].map(o => <div key={o} style={{padding: '9px 18px', background: o === 'Codex' ? '#f5e7df' : 'transparent'}}>{o}</div>)}
          </div>}
        </Phone>
      </div>
      <div style={{position: 'absolute', left: 840, top: 110, width: 960, display: 'grid', gap: 22}}>
        <Eyebrow>Add agents</Eyebrow>
        <div style={{position: 'relative', height: 160}}>
          {headlines.map((h, i) => <div key={h} style={{position: 'absolute', inset: 0, opacity: i === line ? 1 : 0, transform: `translateY(${i === line ? 0 : 14}px)`}}><Headline size={66}>{h}</Headline></div>)}
        </div>
        <div style={{fontFamily: F.body, fontSize: 28, color: C.muted, lineHeight: 1.45, maxWidth: 860, minHeight: 84}}>
          {line < 2 ? 'Leave it on Auto and Laya, running on your Mac, picks the harness and the model.' : 'Tap the picker to choose Claude Code, Codex, Gemini, OpenCode or Pi.'}
        </div>
        {firstSent && f < 236 && (
          <Rise frame={f} at={110}>
            <div style={{border: `2px solid ${C.line}`, borderRadius: 18, background: C.raised, padding: '20px 26px', display: 'grid', gap: 14}}>
              <div style={{display: 'flex', justifyContent: 'space-between', fontFamily: F.mono, fontSize: 21, color: C.mint}}><span>✦ Laya · choosing for “{first}”</span></div>
              {ADD_OPTIONS.map(([label, score, pick], i) => {
                const w = ease(f, 122 + i * 6, 180 + i * 6, 0, score);
                return (
                  <div key={label} style={{display: 'grid', gridTemplateColumns: '320px 1fr 70px', alignItems: 'center', gap: 16, fontFamily: F.mono, fontSize: 21, color: pick && f > 190 ? C.cream : C.muted}}>
                    <span>{pick && f > 190 ? '✓ ' : '  '}{label}</span>
                    <div style={{height: 12, background: '#24302a', borderRadius: 6}}><div style={{height: 12, width: `${w * 100}%`, background: pick ? C.mint : '#4b5c52', borderRadius: 6}} /></div>
                    <span style={{textAlign: 'right'}}>{Math.round(w * 100)}%</span>
                  </div>
                );
              })}
            </div>
          </Rise>
        )}
        {f >= 236 && (
          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20}}>
            <MiniTerminal title="ttys012 · bakery-site · claude" lines={['❯ Build a landing page for my bakery', '⏺ Creating index.html…']} frame={f} at={240} />
            <MiniTerminal title="ttys013 · orders-api · codex" lines={['› Add pagination to the orders API', '• Reading routes/orders.ts']} frame={f} at={345} />
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

// ---------- new: chatting with an agent ----------
const ChatBubble: React.FC<{who: 'you' | 'claude'; children: React.ReactNode; label?: string; status?: string; fade?: number}> = ({who, children, label, status, fade = 1}) => (
  <div style={{opacity: fade, marginBottom: 14}}>
    <div style={{fontFamily: F.mono, fontSize: 14, letterSpacing: '.06em', color: who === 'you' ? '#a6573d' : '#8a8579', marginBottom: 6}}>{label || (who === 'you' ? 'YOU' : 'CLAUDE')}</div>
    <div style={{fontFamily: F.body, fontSize: 18.5, lineHeight: 1.5, color: C.ink, background: who === 'you' ? '#f5e7df' : '#fffdf8', border: `2px solid ${who === 'you' ? '#ecd5c8' : '#e3dccf'}`, borderRadius: 14, padding: '11px 14px'}}>{children}</div>
    {status && <div style={{textAlign: 'right', fontFamily: F.mono, fontSize: 14, color: '#4e7a62', marginTop: 5}}>{status}</div>}
  </div>
);
const FileChip: React.FC<{icon: string; name: string; size: string; pop?: number}> = ({icon, name, size, pop = 1}) => (
  <div style={{display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '6px 12px', border: '2px solid #e3d3c6', borderRadius: 999, background: '#fffdf8', fontFamily: F.body, fontSize: 16, color: C.ink, transform: `scale(${pop})`, transformOrigin: 'left center'}}>
    <span style={{color: '#a6573d'}}>{icon}</span>{name}<span style={{fontFamily: F.mono, fontSize: 13, color: '#8a8579'}}>{size}</span>
  </div>
);
const Chat: React.FC = () => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const followUp = 'Make the header sticky and add our opening hours';
  const sent = f >= 120;
  const tab = f < 380 ? 'Conversation' : f < 490 ? 'Terminal' : 'Files';
  const working = sent && f < 330;
  const reply = 'Updated index.html:\n• A sticky header with your logo\n• Opening hours: Tue–Sun, 7am–3pm\n• Checked it at phone width';
  const replyText = typed(reply, f, 200, 1.4);
  const chipPop = f >= 318 ? spring({frame: f - 318, fps, config: {damping: 12}}) : 0;
  const line = f < 120 ? 0 : f < 200 ? 1 : f < 380 ? 2 : f < 490 ? 3 : 4;
  const headlines = ['Chat with any agent.', 'Your message goes into its real terminal.', 'Replies arrive formatted, files attached.', 'Watch the terminal live.', 'Download what it made.'];
  const subs = [
    'Open an agent from your desk and type, just like a chat app.',
    'Shed types it into the Terminal tab where the session already runs. Same session, same model.',
    'Bold, lists and code show up properly, and any file it mentions gets a download button. Status flips back to Waiting for you.',
    'Stop, switch mode or answer its questions with one tap.',
    'Videos, images and PDFs from the project, with a preview and a Download button.',
  ];
  const tabBtn = (name: string) => <span style={{flex: 1, textAlign: 'center', padding: '8px 0', borderRadius: 10, fontFamily: F.body, fontWeight: 500, fontSize: 17, background: tab === name ? '#fffdf8' : 'transparent', color: tab === name ? C.ink : '#7a766d', boxShadow: tab === name ? '0 1px 3px #0001' : 'none'}}>{name}</span>;
  const renderLines = (text: string) => text.split('\n').map((l, i) => {
    const parts = l.split('index.html');
    const content = parts.length > 1 ? <>{parts[0]}<b>index.html</b>{parts[1]}</> : l;
    return l.startsWith('•') ? <div key={i} style={{paddingLeft: 18, textIndent: -14}}>{content}</div> : <div key={i}>{content}</div>;
  });
  return (
    <AbsoluteFill style={{background: C.night}}>
      <Stars frame={f} />
      <div style={{position: 'absolute', left: 200, top: 90, opacity: ease(f, 0, 14)}}>
        <Phone>
          <div style={{display: 'flex', alignItems: 'center', gap: 10, margin: '0 4px 10px'}}>
            <span style={{width: 34, height: 34, borderRadius: 9, background: '#f5e7df', display: 'grid', placeItems: 'center', color: '#c2603f', fontSize: 18}}>✳</span>
            <span style={{fontFamily: F.body, fontSize: 17, color: '#625f57', letterSpacing: '.03em'}}>CLAUDE · {working ? 'WORKING NOW' : 'WAITING FOR YOU'}</span>
          </div>
          <div style={{display: 'flex', gap: 4, padding: 4, background: '#efeae1', border: '2px solid #e3dccf', borderRadius: 12, marginBottom: 12}}>{tabBtn('Conversation')}{tabBtn('Terminal')}{tabBtn('Files')}</div>
          {tab === 'Conversation' && (
            <div style={{height: 560, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '0 4px'}}>
              <div style={{fontFamily: F.display, fontWeight: 600, fontSize: 24, color: C.ink, marginBottom: 2}}>bakery-site</div>
              <div style={{fontFamily: F.body, fontSize: 15.5, color: '#7a766d', marginBottom: 12}}>Build a landing page for my bakery</div>
              <ChatBubble who="claude">Done. I built <b>index.html</b> with a hero for today’s specials, an order form and a map to the shop.<br /><FileChip icon="▣" name="landing.png" size="240 KB" /></ChatBubble>
              {sent && <ChatBubble who="you" label="YOU · just now" status={f < 160 ? 'Sending to the terminal…' : f < 200 ? 'Delivered' : undefined}>{followUp}</ChatBubble>}
              {f >= 200 && <ChatBubble who="claude">{renderLines(replyText)}{chipPop > 0 && <FileChip icon="▶" name="preview.mp4" size="1.2 MB" pop={chipPop} />}</ChatBubble>}
            </div>
          )}
          {tab === 'Terminal' && (
            <div style={{height: 560, background: C.term, borderRadius: 14, padding: '14px 16px', fontFamily: F.mono, fontSize: 15.5, lineHeight: 1.55, color: '#d9e4dc', whiteSpace: 'pre-wrap', display: 'flex', flexDirection: 'column'}}>
              <div style={{color: '#7d8b82', fontSize: 13}}>Live · ttys012 on the Mac</div>
              <div style={{flex: 1, marginTop: 10}}>
                <div style={{color: C.cream}}>❯ {followUp}</div>
                <div style={{marginTop: 8}}><span style={{color: C.mint}}>⏺</span> Updated index.html:</div>
                <div>  • Sticky header with your logo</div>
                <div>  • Opening hours: Tue–Sun, 7am–3pm</div>
                <div style={{color: '#7d8b82', marginTop: 8}}>✻ Baked for 41s</div>
                <div style={{marginTop: 10}}>❯ <Caret frame={f} /></div>
              </div>
              <div style={{display: 'flex', gap: 7}}>{['Stop', 'Mode', '1', '2', '3', 'Enter'].map(k => <span key={k} style={{flex: k.length > 1 ? 1.4 : 1, textAlign: 'center', padding: '9px 0', borderRadius: 10, background: '#2a2925', border: '2px solid #55514a', color: '#f3f1ea', fontSize: 15}}>{k}</span>)}</div>
            </div>
          )}
          {tab === 'Files' && (
            <div style={{height: 560, padding: '0 4px'}}>
              <div style={{fontFamily: F.body, fontSize: 16, color: '#7a766d', margin: '4px 0 10px'}}>Newest files in <b style={{color: C.ink}}>bakery-site</b></div>
              {[['▶', 'preview.mp4', 'out · 1.2 MB · now', '#f5e7df', '#a6573d'], ['▣', 'landing.png', 'out · 240 KB · 2m ago', '#e5efe9', '#466e58']].map(([icon, name, meta, bg, fg]) => (
                <div key={name} style={{display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '2px solid #ebe5da'}}>
                  <span style={{width: 44, height: 44, borderRadius: 10, background: bg, color: fg, display: 'grid', placeItems: 'center', fontSize: 18}}>{icon}</span>
                  <div style={{flex: 1}}><div style={{fontFamily: F.body, fontWeight: 600, fontSize: 18, color: C.ink}}>{name}</div><div style={{fontFamily: F.mono, fontSize: 13, color: '#8a8579'}}>{meta}</div></div>
                  <span style={{fontFamily: F.body, fontWeight: 600, fontSize: 15, color: '#a6573d', border: '2px solid #e3d3c6', borderRadius: 9, padding: '7px 12px', transform: `scale(${f >= 560 && f < 572 && name === 'preview.mp4' ? 0.9 : 1})`}}>Download</span>
                </div>
              ))}
              <div style={{marginTop: 14, height: 250, borderRadius: 14, overflow: 'hidden', background: '#2b2620', position: 'relative'}}>
                <div style={{position: 'absolute', inset: 0, background: 'linear-gradient(135deg, #f4d7b5, #e9b98c)'}} />
                <div style={{position: 'absolute', left: 0, right: 0, top: 0, height: 44, background: '#5b3a24', display: 'flex', alignItems: 'center', padding: '0 14px', fontFamily: F.display, fontWeight: 800, color: '#fff3e2', fontSize: 20}}>Rise Bakery<span style={{marginLeft: 'auto', fontFamily: F.body, fontWeight: 500, fontSize: 13}}>Tue–Sun 7–3</span></div>
                <div style={{position: 'absolute', left: 16, top: 70, fontFamily: F.display, fontWeight: 800, fontSize: 34, color: '#4a2e1c', lineHeight: 1.05}}>Fresh sourdough<br />every morning</div>
                <div style={{position: 'absolute', left: 16, bottom: 18, background: '#a6573d', color: '#fff', fontFamily: F.body, fontWeight: 600, fontSize: 15, borderRadius: 9, padding: '8px 14px'}}>Order for pickup</div>
                <div style={{position: 'absolute', right: 12, bottom: 12, width: 44, height: 44, borderRadius: '50%', background: '#0008', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 18}}>▶</div>
              </div>
            </div>
          )}
          <div style={{position: 'absolute', left: 22, right: 22, bottom: 28, display: tab === 'Conversation' ? 'flex' : 'none', gap: 10, alignItems: 'flex-end'}}>
            <div style={{flex: 1, minHeight: 56, background: '#fffdf8', border: `2px solid ${f >= 30 && f < 120 ? '#a6573d' : '#ddd3c6'}`, borderRadius: 14, padding: '12px 14px', fontFamily: F.body, fontSize: 18, color: f >= 30 && f < 120 ? C.ink : '#9a958b'}}>{f >= 30 && f < 120 ? typed(followUp, f, 34, 0.62) : 'Message Claude Code…'}</div>
            <span style={{height: 56, padding: '0 18px', borderRadius: 14, background: '#a6573d', color: '#fff', display: 'grid', placeItems: 'center', fontFamily: F.body, fontWeight: 600, fontSize: 18, transform: `scale(${f >= 112 && f < 122 ? 0.88 : 1})`}}>Send</span>
          </div>
        </Phone>
      </div>
      <div style={{position: 'absolute', left: 840, top: 200, width: 940, display: 'grid', gap: 24}}>
        <Eyebrow>Chat</Eyebrow>
        <div style={{position: 'relative', height: 170}}>
          {headlines.map((h, i) => <div key={h} style={{position: 'absolute', inset: 0, opacity: i === line ? 1 : 0, transform: `translateY(${i === line ? 0 : 14}px)`}}><Headline size={70}>{h}</Headline></div>)}
        </div>
        <div style={{position: 'relative', height: 140}}>
          {subs.map((t, i) => <div key={t} style={{position: 'absolute', inset: 0, opacity: i === line ? 1 : 0, fontFamily: F.body, fontSize: 30, lineHeight: 1.45, color: C.muted}}>{t}</div>)}
        </div>
        <div style={{display: 'flex', gap: 14, marginTop: 10}}>
          {[['Waiting for you', !working, '#a6b0a3'], ['Typing away', working, C.mint]].map(([label, on, color]) => (
            <span key={label as string} style={{fontFamily: F.mono, fontSize: 22, padding: '8px 16px', borderRadius: 999, border: `2px solid ${on ? color : C.line}`, color: on ? (color as string) : '#55635a'}}>● {label}</span>
          ))}
        </div>
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
      {f >= 168 && f < 236 && (
        <div style={{position: 'absolute', left: 150, top: 300 + ease(f, 168, 182, -60, 0), width: 340, opacity: Math.min(ease(f, 168, 178), ease(f, 226, 236, 1, 0)), background: '#fbfaf7ee', borderRadius: 22, padding: '14px 16px', boxShadow: '0 18px 40px #0006', display: 'flex', gap: 12, alignItems: 'center', zIndex: 5}}>
          <div style={{flex: 'none'}}><ShedLogo size={46} frame={f} /></div>
          <div style={{fontFamily: F.body, color: C.ink}}><div style={{fontWeight: 600, fontSize: 18}}>Claude needs your OK</div><div style={{fontSize: 15, color: '#625f57'}}>web-app: Do you want to edit login.test.js?</div></div>
        </div>
      )}
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
  {title: 'Live status and notifications', body: 'See who is typing, who is waiting and who needs your OK, and get a ping the moment it changes.', art: 'restart'},
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
  [Intro, 0, 140],
  [Desk, 140, 200],
  [AddAgents, 340, 470],
  [Chat, 810, 620],
  [Handoff, 1430, 370],
  [Highlights, 1800, 300],
  [Connect, 2100, 300],
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
