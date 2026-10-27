import React from 'react';
import {AbsoluteFill, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, F, useFonts, ShedLogo, Eyebrow, Headline, Stars} from './shed-tour';
import shots from '../public/product/shots.json';

// The product reel: real screens of the Shed web app (captured by video/capture/capture.mjs from the running app,
// with a demo data set), paced slowly enough to talk over each feature. Landscape 1920x1080, no audio.
type Shot = keyof typeof shots;
type Tap = {x: number; y: number};
const tapOf = (shot: Shot, key: string): Tap => (shots[shot].taps as Record<string, Tap>)[key];

const ease = (f: number, a: number, b: number, from = 0, to = 1) => interpolate(f, [a, b], [from, to], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: t => t * t * (3 - 2 * t)});
const Fade: React.FC<{at: number; len?: number; children: React.ReactNode; style?: React.CSSProperties}> = ({at, len = 14, children, style}) => {
  const f = useCurrentFrame();
  if (f < at) return null;
  return <div style={{opacity: ease(f, at, at + len), ...style}}>{children}</div>;
};
const Rise: React.FC<{at: number; children: React.ReactNode; style?: React.CSSProperties}> = ({at, children, style}) => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = f < at ? 0 : spring({frame: f - at, fps, config: {damping: 200}});
  return <div style={{opacity: s, transform: `translateY(${(1 - s) * 26}px)`, ...style}}>{children}</div>;
};
const NewTag: React.FC = () => <span style={{fontFamily: F.pixel, fontSize: 20, letterSpacing: '.08em', color: C.night, background: C.mint, padding: '6px 12px', borderRadius: 6, marginRight: 14, verticalAlign: 3}}>NEW</span>;

// Captions change with the step being shown; each one fades in over the last.
type Step = {at: number; title: string; sub?: string};
const Captions: React.FC<{eyebrow: string; isNew?: boolean; steps: Step[]; size?: number; width?: number}> = ({eyebrow, isNew, steps, size = 74, width = 820}) => {
  const f = useCurrentFrame();
  const current = steps.filter(s => f >= s.at).length - 1;
  return (
    <div style={{display: 'grid', gap: 20, width}}>
      <Rise at={0}><Eyebrow>{isNew && <NewTag />}{eyebrow}</Eyebrow></Rise>
      <div style={{position: 'relative', minHeight: size * 2.3}}>
        {steps.map((s, i) => (
          <div key={i} style={{position: 'absolute', inset: 0, opacity: i === current ? ease(f, s.at, s.at + 12) : 0, transform: `translateY(${i === current ? ease(f, s.at, s.at + 12, 18, 0) : 0}px)`}}>
            <Headline size={size}>{s.title}</Headline>
            {s.sub && <div style={{fontFamily: F.body, fontSize: 32, lineHeight: 1.45, color: C.muted, marginTop: 22}}>{s.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );
};

// A finger tap: a dot presses in, then a ring spreads out.
const TapMark: React.FC<{x: number; y: number; at: number}> = ({x, y, at}) => {
  const f = useCurrentFrame();
  if (f < at - 10 || f > at + 24) return null;
  const press = ease(f, at - 10, at, 0, 1), ring = ease(f, at, at + 20);
  return (
    <div style={{position: 'absolute', left: x, top: y, pointerEvents: 'none'}}>
      <div style={{position: 'absolute', left: -26, top: -26, width: 52, height: 52, borderRadius: '50%', background: '#2a2520', opacity: 0.32 * press * (1 - ring), transform: `scale(${1.15 - press * 0.2})`}} />
      <div style={{position: 'absolute', left: -26, top: -26, width: 52, height: 52, borderRadius: '50%', border: `4px solid ${C.roof}`, opacity: 1 - ring, transform: `scale(${1 + ring * 1.4})`}} />
    </div>
  );
};

// A sequence of real screens: each fades in over the previous at its frame. Taps are placed in the screen's own pixels.
type Screen = {shot: Shot; at: number; tap?: {key: string; at: number}};
const ScreenStack: React.FC<{screens: Screen[]; scale: number; crop?: {y: number; h: number}}> = ({screens, scale, crop}) => {
  const f = useCurrentFrame();
  const visible = screens.filter(s => f >= s.at);
  return (
    <>
      {visible.map((s, i) => (
        <div key={s.shot + i} style={{position: 'absolute', inset: 0, opacity: i === 0 ? 1 : ease(f, s.at, s.at + 10)}}>
          <Img src={staticFile(shots[s.shot].file)} style={{width: shots[s.shot].width * scale, display: 'block', marginTop: crop ? -crop.y * scale : 0}} />
        </div>
      ))}
      {screens.filter(s => s.tap).map(s => {
        const t = tapOf(s.shot, s.tap!.key);
        return t ? <TapMark key={s.shot + s.tap!.key} x={t.x * scale} y={t.y * scale - (crop?.y || 0) * scale} at={s.tap!.at} /> : null;
      })}
    </>
  );
};

// iPhone-style frame around phone captures (390x844 points).
const PHONE_W = 410;
// Camera moves: from frame `at`, push in to `zoom` around screen height `y` (in the capture's points), so the part
// being talked about is big enough to read. Zoom 1 shows the whole phone.
type Cam = {at: number; y: number; zoom: number};
const camAt = (cams: Cam[], f: number) => {
  // Each move starts from wherever the previous move had got to.
  let pos = {y: 422, zoom: 1};
  for (const c of cams) {
    if (f < c.at) break;
    pos = interp(pos, c, ease(f, c.at, c.at + 24));
  }
  return pos;
};
const interp = (a: {y: number; zoom: number}, b: {y: number; zoom: number}, t: number) => ({y: a.y + (b.y - a.y) * t, zoom: a.zoom + (b.zoom - a.zoom) * t});
const PhoneFrame: React.FC<{screens: Screen[]; x?: number; y?: number; cams?: Cam[]}> = ({screens, x = 230, y = 64, cams = []}) => {
  const f = useCurrentFrame();
  const scale = PHONE_W / 390;
  const cam = camAt(cams, f);
  const pointY = 14 + cam.y * scale; // inside the frame
  const lift = (540 - (y + pointY)) * ((cam.zoom - 1) / 0.5); // bring the focus toward the middle as it zooms
  return (
    <div style={{position: 'absolute', left: x, top: y + ease(f, 0, 18, 40, 0), opacity: ease(f, 0, 12), transform: `translateY(${Math.max(-700, Math.min(500, lift))}px) scale(${cam.zoom})`, transformOrigin: `${PHONE_W / 2 + 14}px ${pointY}px`}}>
      <div style={{padding: 14, borderRadius: 64, background: '#0b0f0d', boxShadow: `0 0 0 3px #33443a, 0 50px 110px #000c`}}>
        <div style={{position: 'relative', width: PHONE_W, height: 844 * scale, borderRadius: 50, overflow: 'hidden', background: C.paper}}>
          <ScreenStack screens={screens} scale={scale} />
          <div style={{position: 'absolute', top: 10, left: '50%', marginLeft: -62, width: 124, height: 34, borderRadius: 20, background: '#0b0f0d'}} />
        </div>
      </div>
    </div>
  );
};

// Browser window around desktop captures (1600x1000), with an optional slow zoom to a point of the page.
const BrowserFrame: React.FC<{shot: Shot; width: number; x: number; y: number; height: number; zoom?: {at: number; to: number; cx: number; cy: number; len?: number}}> = ({shot, width, x, y, height, zoom}) => {
  const f = useCurrentFrame();
  const scale = width / 1600;
  const z = zoom ? ease(f, zoom.at, zoom.at + (zoom.len || 50), 1, zoom.to) : 1;
  return (
    <div style={{position: 'absolute', left: x, top: y + ease(f, 0, 18, 40, 0), opacity: ease(f, 0, 12), width, borderRadius: 16, overflow: 'hidden', boxShadow: '0 0 0 2px #33443a, 0 40px 100px #000b', background: C.paper}}>
      <div style={{height: 44, background: '#e9e2d4', display: 'flex', alignItems: 'center', gap: 9, padding: '0 18px'}}>
        {['#e0675b', '#e9b44c', '#5fbf6b'].map(c => <i key={c} style={{width: 13, height: 13, borderRadius: '50%', background: c}} />)}
        <div style={{marginLeft: 20, flex: 1, maxWidth: 520, height: 26, borderRadius: 8, background: '#f7f2e8', fontFamily: F.body, fontSize: 15, color: '#7a766d', display: 'flex', alignItems: 'center', padding: '0 12px'}}>localhost:4378</div>
      </div>
      <div style={{position: 'relative', height, overflow: 'hidden'}}>
        <div style={{transform: `scale(${z})`, transformOrigin: zoom ? `${zoom.cx * scale}px ${zoom.cy * scale}px` : '0 0'}}>
          <Img src={staticFile(shots[shot].file)} style={{width, display: 'block'}} />
        </div>
      </div>
    </div>
  );
};

const Scene: React.FC<{children: React.ReactNode}> = ({children}) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{background: C.night}}><Stars frame={f} />{children}</AbsoluteFill>;
};
const Side: React.FC<{children: React.ReactNode; top?: number}> = ({children, top = 250}) => <div style={{position: 'absolute', left: 860, top}}>{children}</div>;

// ---------- scenes ----------
const Intro: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Scene>
      <AbsoluteFill style={{display: 'grid', placeItems: 'center'}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 70}}>
          <ShedLogo size={330} frame={f} rowsShown={Math.floor(ease(f, 4, 40, 0, 15))} tile={false} />
          <div style={{display: 'grid', gap: 20}}>
            <Rise at={34}><div style={{fontFamily: F.display, fontWeight: 800, fontSize: 180, letterSpacing: '-0.04em', lineHeight: 0.88, color: C.cream}}>Shed</div></Rise>
            <Rise at={52}><div style={{fontFamily: F.display, fontWeight: 800, fontSize: 60, letterSpacing: '-0.02em', color: C.roof, lineHeight: 1.08}}>Your coding agents,<br />in your pocket.</div></Rise>
          </div>
        </div>
      </AbsoluteFill>
    </Scene>
  );
};

const Desk: React.FC = () => (
  <Scene>
    <div style={{position: 'absolute', left: 120, top: 54}}><Captions eyebrow="On your Mac" size={68} width={1700} steps={[{at: 0, title: 'Every coding agent on your Mac, in one place.'}]} /></div>
    <BrowserFrame shot="d-home" width={1500} x={210} y={230} height={800} zoom={{at: 70, to: 1.35, cx: 760, cy: 330, len: 90}} />
  </Scene>
);

const JustMessage: React.FC = () => (
  <Scene>
    <PhoneFrame screens={[{shot: 'p-home', at: 0, tap: {key: 'input', at: 40}}, {shot: 'p-typed', at: 58, tap: {key: 'send', at: 120}}, {shot: 'p-sent', at: 134}]} cams={[{at: 22, y: 700, zoom: 1.45}, {at: 134, y: 300, zoom: 1.4}]} />
    <Side><Captions eyebrow="From your phone" steps={[
      {at: 0, title: 'Just message.', sub: 'Type what you need from anywhere.'},
      {at: 134, title: 'Shed picks the agent and the model.', sub: 'It runs on your Mac, opens a Terminal window and starts work.'},
    ]} /></Side>
  </Scene>
);

const Approve: React.FC = () => (
  <Scene>
    <PhoneFrame screens={[{shot: 'p-asking', at: 0, tap: {key: 'yes', at: 104}}, {shot: 'p-approved', at: 120}]} cams={[{at: 16, y: 300, zoom: 1.4}, {at: 66, y: 600, zoom: 1.4}, {at: 124, y: 260, zoom: 1.4}]} />
    <Side><Captions eyebrow="The real terminal" steps={[
      {at: 0, title: 'When an agent asks, you answer.', sub: 'See its real Terminal and tap one of its own options.'},
      {at: 120, title: 'Approved. Work continues.', sub: 'The test is fixed while you’re away from your desk.'},
    ]} /></Side>
  </Scene>
);

const ChatFiles: React.FC = () => (
  <Scene>
    <PhoneFrame screens={[{shot: 'p-chat', at: 0}, {shot: 'p-files', at: 96, tap: {key: 'preview', at: 150}}, {shot: 'p-files-preview', at: 164, tap: {key: 'download', at: 220}}]} cams={[{at: 14, y: 420, zoom: 1.4}, {at: 96, y: 230, zoom: 1.4}, {at: 166, y: 360, zoom: 1.35}]} />
    <Side><Captions eyebrow="Chat and files" steps={[
      {at: 0, title: 'Chat with any agent.', sub: 'Replies arrive formatted, with the files they mention.'},
      {at: 96, title: 'Preview what it made.', sub: 'Images, videos and PDFs from the project.'},
      {at: 200, title: 'Download it in one tap.'},
    ]} /></Side>
  </Scene>
);

const Attach: React.FC = () => (
  <Scene>
    <PhoneFrame screens={[{shot: 'p-home', at: 0, tap: {key: 'input', at: 1000}}, {shot: 'p-attach', at: 50}]} cams={[{at: 50, y: 690, zoom: 1.5}]} />
    <Side><Captions isNew eyebrow="Attachments" steps={[{at: 0, title: 'Attach screenshots and files.', sub: 'They’re saved into the project on your Mac, and the agent is told where they are.'}]} /></Side>
  </Scene>
);

const Model: React.FC = () => (
  <Scene>
    <PhoneFrame screens={[{shot: 'p-home', at: 0}, {shot: 'p-model', at: 40, tap: {key: 'model', at: 80}}]} cams={[{at: 40, y: 700, zoom: 1.5}]} />
    <Side><Captions isNew eyebrow="Your choice" steps={[{at: 0, title: 'Or pick the agent and model yourself.', sub: 'Claude Code, Codex, Gemini, OpenCode or Pi, and any model you’ve enabled.'}]} /></Side>
  </Scene>
);

const Talk: React.FC = () => (
  <Scene>
    <PhoneFrame screens={[{shot: 'p-talk-button', at: 0, tap: {key: 'talk', at: 70}}, {shot: 'p-talk-dialog', at: 84, tap: {key: 'send', at: 190}}, {shot: 'p-talk-reply', at: 206}]} cams={[{at: 10, y: 330, zoom: 1.4}, {at: 86, y: 450, zoom: 1.4}, {at: 208, y: 480, zoom: 1.4}]} />
    <Side><Captions isNew eyebrow="Sessions talk" steps={[
      {at: 0, title: 'Your agents can talk to each other.'},
      {at: 84, title: 'Introduce two sessions.', sub: 'Say what they should work out. Shed shows the first how to reach the second.'},
      {at: 206, title: 'One asks, the other answers.', sub: 'Messages from another agent are marked, so you always know who said what.'},
    ]} /></Side>
  </Scene>
);

const TalkDesk: React.FC = () => (
  <Scene>
    <div style={{position: 'absolute', left: 120, top: 54}}><Captions isNew eyebrow="Sessions talk" size={68} width={1700} steps={[{at: 0, title: 'See every exchange between your agents.'}]} /></div>
    <BrowserFrame shot="d-home" width={1500} x={210} y={230} height={800} zoom={{at: 20, to: 1.55, cx: 760, cy: 640, len: 70}} />
  </Scene>
);

const Share: React.FC = () => (
  <Scene>
    <PhoneFrame screens={[{shot: 'p-settings-share', at: 0, tap: {key: 'get', at: 90}}]} cams={[{at: 10, y: 280, zoom: 1.35}, {at: 70, y: 540, zoom: 1.35}]} />
    <Side><Captions isNew eyebrow="Share from iPhone" steps={[{at: 0, title: 'Share any post to Shed.', sub: 'Send an Instagram post, a TikTok or a link from the share sheet. Shed grabs the video and caption, and an agent starts on it.'}]} /></Side>
  </Scene>
);

const Idle: React.FC = () => (
  <Scene>
    <PhoneFrame screens={[{shot: 'p-settings-idle', at: 0, tap: {key: 'toggle', at: 80}}]} cams={[{at: 10, y: 620, zoom: 1.45}]} />
    <Side><Captions isNew eyebrow="Tidy desk" steps={[{at: 0, title: 'Idle sessions close themselves.', sub: 'After 12 hours with no activity, Shed ends the session and closes its Terminal window. Sessions that are working are never touched.'}]} /></Side>
  </Scene>
);

const Outro: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Scene>
      <AbsoluteFill style={{display: 'grid', placeItems: 'center'}}>
        <div style={{display: 'grid', justifyItems: 'center', gap: 30}}>
          <ShedLogo size={240} frame={f} />
          <Rise at={10}><div style={{fontFamily: F.display, fontWeight: 800, fontSize: 140, letterSpacing: '-0.04em', color: C.cream, lineHeight: 0.9}}>Shed</div></Rise>
          <Rise at={22}><div style={{fontFamily: F.display, fontWeight: 800, fontSize: 58, color: C.roof}}>Your desk, in your pocket.</div></Rise>
          <Rise at={36}><Eyebrow>Open source · Runs on your Mac</Eyebrow></Rise>
        </div>
      </AbsoluteFill>
    </Scene>
  );
};

// [scene, frames at 30fps]. Scenes cross-fade into each other over 12 frames.
const SCENES: [React.FC, number][] = [
  [Intro, 110], [Desk, 190], [JustMessage, 270], [Approve, 230], [ChatFiles, 280], [Attach, 170], [Model, 170],
  [Talk, 330], [TalkDesk, 170], [Share, 190], [Idle, 190], [Outro, 140],
];
const OVERLAP = 12;
export const PRODUCT_FRAMES = SCENES.reduce((sum, [, n]) => sum + n, 0) - OVERLAP * (SCENES.length - 1);

export const ShedProduct: React.FC = () => {
  useFonts();
  let from = 0;
  return (
    <AbsoluteFill style={{background: C.night}}>
      {SCENES.map(([S, n], i) => {
        const start = from;
        from += n - OVERLAP;
        return (
          <Sequence key={i} from={start} durationInFrames={n}>
            <SceneFade len={n} first={i === 0}><S /></SceneFade>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
const SceneFade: React.FC<{len: number; first: boolean; children: React.ReactNode}> = ({len, first, children}) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{opacity: Math.min(first ? 1 : ease(f, 0, OVERLAP), ease(f, len - OVERLAP, len, 1, 0))}}>{children}</AbsoluteFill>;
};
