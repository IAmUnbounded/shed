import React, {createContext, useContext} from 'react';
import {AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, F, useFonts, Agent, ShedLogo, ease, typed, Eyebrow, Headline, Stars, TerminalWindow, Caret, PhoneCard, Phone, MessageBar, DeskCard, FileChip} from './shed-tour';

// A fast-cut landscape reel of Shed and its newest features: hard cuts every one to four seconds, no audio
// (music goes on top in the editing app). Same palette, fonts and pixel agents as the tour and the app.

// ---------- cut helpers ----------
// Each cut can play its animations slower than real time, so there's room to talk over every feature.
const Speed = createContext(1);
const useF = () => useCurrentFrame() / useContext(Speed);
// Every scene lands with a punch: a quick zoom settle and a light flash, which reads as a beat cut.
const Punch: React.FC<{children: React.ReactNode}> = ({children}) => {
  const f = useCurrentFrame();
  const zoom = interpolate(f, [0, 7], [1.07, 1], {extrapolateRight: 'clamp', easing: t => 1 - Math.pow(1 - t, 3)});
  const flash = interpolate(f, [0, 4], [0.28, 0], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{background: C.night}}>
      <AbsoluteFill style={{transform: `scale(${zoom})`}}>{children}</AbsoluteFill>
      <AbsoluteFill style={{background: C.cream, opacity: flash, pointerEvents: 'none'}} />
    </AbsoluteFill>
  );
};
const Pop: React.FC<{at: number; children: React.ReactNode; style?: React.CSSProperties; from?: number}> = ({at, children, style, from = 0.6}) => {
  const f = useF();
  const {fps} = useVideoConfig();
  if (f < at) return null;
  const s = spring({frame: f - at, fps, config: {damping: 12, stiffness: 220}});
  return <div style={{transform: `scale(${from + (1 - from) * s})`, opacity: Math.min(1, s * 1.6), ...style}}>{children}</div>;
};
const Slide: React.FC<{at: number; children: React.ReactNode; style?: React.CSSProperties; dy?: number}> = ({at, children, style, dy = 40}) => {
  const f = useF();
  const {fps} = useVideoConfig();
  if (f < at) return null;
  const s = spring({frame: f - at, fps, config: {damping: 18, stiffness: 260}});
  return <div style={{transform: `translateY(${(1 - s) * dy}px)`, opacity: s, ...style}}>{children}</div>;
};
const NewTag: React.FC = () => (
  <span style={{fontFamily: F.pixel, fontSize: 20, letterSpacing: '.08em', color: C.night, background: C.mint, padding: '6px 12px', borderRadius: 6, marginRight: 14, verticalAlign: 4}}>NEW</span>
);
// Headline block used on most cuts: eyebrow, big line, optional subline.
const Caption: React.FC<{eyebrow: string; title: React.ReactNode; sub?: string; isNew?: boolean; size?: number; at?: number; style?: React.CSSProperties}> = ({eyebrow, title, sub, isNew, size = 88, at = 0, style}) => (
  <div style={{display: 'grid', gap: 18, ...style}}>
    <Slide at={at}><Eyebrow>{isNew && <NewTag />}{eyebrow}</Eyebrow></Slide>
    <Slide at={at + 2}><Headline size={size}>{title}</Headline></Slide>
    {sub && <Slide at={at + 6}><div style={{fontFamily: F.body, fontSize: 34, lineHeight: 1.4, color: C.muted, maxWidth: 900}}>{sub}</div></Slide>}
  </div>
);
const Scene: React.FC<{children: React.ReactNode}> = ({children}) => {
  const f = useF();
  return <Punch><Stars frame={f} />{children}</Punch>;
};
const at = (x: number, y: number, extra: React.CSSProperties = {}): React.CSSProperties => ({position: 'absolute', left: x, top: y, ...extra});
const PhoneAt: React.FC<{x: number; y: number; scale?: number; children: React.ReactNode}> = ({x, y, scale = 0.9, children}) => (
  <div style={at(x, y, {transform: `scale(${scale})`, transformOrigin: 'top left'})}><Phone>{children}</Phone></div>
);

// ---------- 1. hook ----------
const HookAgents: React.FC = () => {
  const f = useF();
  return (
    <Scene>
      <AbsoluteFill style={{display: 'grid', placeItems: 'center'}}>
        <div style={{display: 'grid', justifyItems: 'center', gap: 50}}>
          <Headline size={150}>Your coding agents</Headline>
          <div style={{display: 'flex', gap: 30}}>
            {['claude', 'codex', 'gemini', 'opencode', 'pi'].map((name, i) => <Pop key={name} at={2 + i * 3}><Agent name={name} mood="working" size={210} frame={f} seed={i} /></Pop>)}
          </div>
        </div>
      </AbsoluteFill>
    </Scene>
  );
};
const HookShed: React.FC = () => {
  const f = useF();
  return (
    <Scene>
      <AbsoluteFill style={{display: 'grid', placeItems: 'center'}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 70}}>
          <Pop at={0} from={1.4}><ShedLogo size={360} frame={f} tile={false} /></Pop>
          <div style={{display: 'grid', gap: 18}}>
            <Slide at={3}><div style={{fontFamily: F.display, fontWeight: 800, fontSize: 200, letterSpacing: '-0.04em', lineHeight: 0.85, color: C.cream}}>Shed</div></Slide>
            <Slide at={9}><div style={{fontFamily: F.display, fontWeight: 800, fontSize: 72, letterSpacing: '-0.02em', color: C.roof}}>now in your pocket.</div></Slide>
          </div>
        </div>
      </AbsoluteFill>
    </Scene>
  );
};

// ---------- 2. message from the phone ----------
const LAYA = [['Claude Code · Opus', 0.84, true], ['Codex · gpt-6', 0.11, false], ['Gemini · 2.5 Pro', 0.05, false]] as const;
const Message: React.FC = () => {
  const f = useF();
  const msg = 'Fix the flaky login test';
  const sent = f >= 30;
  return (
    <Scene>
      <PhoneAt x={190} y={70}>
        <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 38, color: C.ink, margin: '4px 6px 14px'}}>Live sessions</div>
        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14}}>
          <PhoneCard agent="claude" mood={sent ? 'working' : 'open'} project="web-app" frame={f} />
          <PhoneCard agent="codex" mood="working" project="shop-api" frame={f} seed={2} />
        </div>
        <div style={{position: 'absolute', left: 22, right: 22, bottom: 30}}>
          <MessageBar text={sent ? 'Message Shed…' : typed(msg, f, 2, 1.1) || 'Message Shed…'} placeholder={sent || f < 3} pressed={f >= 26 && f < 32} />
        </div>
      </PhoneAt>
      <div style={at(820, 170, {width: 980})}>
        <Caption eyebrow="From anywhere" title="Just message." />
        {sent && (
          <Slide at={32} style={{marginTop: 50}}>
            <div style={{border: `2px solid ${C.line}`, borderRadius: 20, background: C.raised, padding: '26px 30px', display: 'grid', gap: 18}}>
              <div style={{fontFamily: F.mono, fontSize: 24, color: C.mint}}>✦ Laya picks the agent · on your Mac</div>
              {LAYA.map(([label, score, pick], i) => {
                const w = ease(f, 34 + i * 2, 50 + i * 2, 0, score);
                return (
                  <div key={label} style={{display: 'grid', gridTemplateColumns: '330px 1fr 80px', alignItems: 'center', gap: 18, fontFamily: F.mono, fontSize: 24, color: pick && f > 50 ? C.cream : C.muted}}>
                    <span>{pick && f > 50 ? '✓ ' : '  '}{label}</span>
                    <div style={{height: 14, background: '#24302a', borderRadius: 7}}><div style={{height: 14, width: `${w * 100}%`, background: pick ? C.mint : '#4b5c52', borderRadius: 7}} /></div>
                    <span style={{textAlign: 'right'}}>{Math.round(w * 100)}%</span>
                  </div>
                );
              })}
            </div>
          </Slide>
        )}
      </div>
    </Scene>
  );
};

// ---------- 3. the real terminal ----------
const RealTerminal: React.FC = () => {
  const f = useF();
  return (
    <Scene>
      <div style={at(120, 80)}><Caption eyebrow="Real terminal" title="Typed into the Terminal on your Mac." size={76} /></div>
      <div style={at(260, 330, {width: 1400})}>
        <TerminalWindow title="ttys003 · ~/web-app · Claude Code" fontSize={34}>
          <div style={{color: C.cream}}>{typed('❯ Fix the flaky login test', f, 0, 2.4)}</div>
          {f >= 12 && <div style={{color: C.mint, marginTop: 10}}>{typed('⏺ Reading tests/login.test.js', f, 12, 2.4)}</div>}
          {f >= 22 && <div style={{color: '#d9e4dc'}}>{typed('⏺ The test races the session cookie.', f, 22, 2.4)}</div>}
          {f >= 34 && <div style={{color: C.mint}}>{typed('⏺ npm test: 14 passed', f, 34, 2.4)}</div>}
          <div style={{marginTop: 10}}>❯ <Caret frame={f} /></div>
        </TerminalWindow>
      </div>
    </Scene>
  );
};

// ---------- 4. approve from the phone ----------
const Approve: React.FC = () => {
  const f = useF();
  const tapped = f >= 28;
  return (
    <Scene>
      <PhoneAt x={190} y={70}>
        <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 36, color: C.ink, margin: '4px 6px 14px'}}>web-app</div>
        <PhoneCard agent="claude" mood={tapped ? 'working' : 'asking'} project="Do you want to edit login.test.js?" frame={f} />
        <div style={{marginTop: 22, display: 'grid', gap: 12}}>
          {['Yes', 'Yes, and don’t ask again', 'No'].map((label, i) => {
            const tap = i === 0 && f >= 22 && f < 30;
            return <div key={label} style={{padding: '18px 20px', borderRadius: 16, fontFamily: F.body, fontWeight: 600, fontSize: 24, background: i === 0 ? (tapped ? '#466e58' : '#a6573d') : '#2a2925', color: '#f3f1ea', transform: `scale(${tap ? 0.92 : 1})`, boxShadow: tap ? '0 0 0 6px #e7b9a6' : 'none'}}>{i === 0 && tapped ? '✓ Approved' : label}</div>;
          })}
        </div>
      </PhoneAt>
      <Slide at={0} dy={-80} style={at(170, 40, {width: 420, zIndex: 3})}>
        {f < 22 && <div style={{background: '#fbfaf7f2', borderRadius: 24, padding: '16px 18px', boxShadow: '0 18px 40px #0007', display: 'flex', gap: 14, alignItems: 'center'}}>
          <ShedLogo size={52} frame={f} />
          <div style={{fontFamily: F.body, color: C.ink}}><div style={{fontWeight: 600, fontSize: 21}}>Claude needs your OK</div><div style={{fontSize: 17, color: '#625f57'}}>web-app: edit login.test.js?</div></div>
        </div>}
      </Slide>
      <div style={at(820, 280, {width: 980})}><Caption eyebrow="Needs your OK" title={tapped ? 'Approved. Work continues.' : 'Approve from anywhere.'} sub="It shows the agent’s real options. One tap answers." /></div>
    </Scene>
  );
};

// ---------- 5. NEW: share from the iPhone ----------
const Share: React.FC = () => {
  const f = useF();
  const {fps} = useVideoConfig();
  const sheet = f >= 14 ? spring({frame: f - 14, fps, config: {damping: 18, stiffness: 200}}) : 0;
  const tapped = f >= 40;
  return (
    <Scene>
      <PhoneAt x={190} y={70}>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, margin: '0 4px 12px'}}>
          <div style={{width: 40, height: 40, borderRadius: '50%', background: 'linear-gradient(135deg, #f6b26b, #d9774f)'}} />
          <div style={{fontFamily: F.body, fontWeight: 600, fontSize: 20, color: C.ink}}>rise.bakery</div>
        </div>
        <div style={{height: 470, borderRadius: 16, overflow: 'hidden', position: 'relative', background: 'linear-gradient(160deg, #f4d7b5, #d9a06e)'}}>
          <div style={{position: 'absolute', left: 24, top: 40, fontFamily: F.display, fontWeight: 800, fontSize: 52, lineHeight: 1, color: '#4a2e1c'}}>3 bread<br />hacks that<br />went viral</div>
          <div style={{position: 'absolute', right: 20, bottom: 20, width: 64, height: 64, borderRadius: '50%', background: '#0007', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 26}}>▶</div>
        </div>
        <div style={{display: 'flex', gap: 22, margin: '14px 6px', fontSize: 30, color: C.ink}}><span>♡</span><span>💬</span><span style={{transform: `scale(${f >= 8 && f < 14 ? 0.8 : 1})`}}>➤</span></div>
        {sheet > 0 && (
          <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: 360, transform: `translateY(${(1 - sheet) * 360}px)`, background: '#f2efe9', borderRadius: '30px 30px 52px 52px', padding: '22px 22px', boxShadow: '0 -20px 50px #0003'}}>
            <div style={{width: 60, height: 6, borderRadius: 3, background: '#cfc8bb', margin: '0 auto 20px'}} />
            <div style={{fontFamily: F.body, fontSize: 18, color: '#7a766d', marginBottom: 14}}>Share</div>
            <div style={{display: 'grid', gap: 10}}>
              {['Copy Link', 'Send to Shed', 'Add to Reading List'].map(label => {
                const shed = label === 'Send to Shed';
                return <div key={label} style={{display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 14, background: shed ? (tapped ? '#e5efe9' : '#fffdf8') : '#fffdf8', border: `2px solid ${shed ? '#a6573d' : '#e3dccf'}`, fontFamily: F.body, fontWeight: shed ? 600 : 400, fontSize: 21, color: C.ink, transform: `scale(${shed && f >= 34 && f < 42 ? 0.94 : 1})`}}>
                  {shed ? <ShedLogo size={36} frame={f} /> : <span style={{width: 36, textAlign: 'center', color: '#8a8579'}}>{label === 'Copy Link' ? '⧉' : '◎'}</span>}{label}
                </div>;
              })}
            </div>
          </div>
        )}
        {f >= 46 && <Slide at={46} dy={-30} style={{position: 'absolute', left: 22, right: 22, top: 70}}>
          <div style={{background: '#fbfaf7f5', borderRadius: 20, padding: '14px 16px', boxShadow: '0 16px 36px #0005', display: 'flex', gap: 12, alignItems: 'center'}}>
            <ShedLogo size={44} frame={f} />
            <div style={{fontFamily: F.body, fontSize: 18, color: C.ink, lineHeight: 1.3}}><b>Got it.</b> Fetching the post, then an agent gets to work.</div>
          </div>
        </Slide>}
      </PhoneAt>
      <div style={at(820, 250, {width: 1000})}><Caption isNew eyebrow="Share from iPhone" title="Share any post or link." sub="Shed grabs the video and caption, and an agent starts on it." /></div>
    </Scene>
  );
};

// ---------- 6. NEW: attachments ----------
const ATTACHED = [['▣', 'checkout-bug.png', '412 KB', 'linear-gradient(135deg, #f4d7b5, #e9b98c)'], ['▤', 'spec.pdf', '1.1 MB', 'linear-gradient(135deg, #ece8f6, #cfc6ea)'], ['▶', 'repro.mov', '8.4 MB', 'linear-gradient(135deg, #2d3a33, #131b17)']] as const;
const Attach: React.FC = () => {
  const f = useF();
  return (
    <Scene>
      <div style={at(120, 80, {width: 1680})}><Caption isNew eyebrow="Attachments" title="Attach screenshots and files." sub="They land in the project on your Mac, and the agent is told where." size={84} /></div>
      <div style={at(120, 440, {width: 1680, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 30})}>
        {ATTACHED.map(([icon, name, size, bg], i) => (
          <Pop key={name} at={4 + i * 5}>
            <div style={{background: '#fffdf8', border: '2px solid #e3dccf', borderRadius: 22, overflow: 'hidden'}}>
              <div style={{height: 220, background: bg, display: 'grid', placeItems: 'center', fontSize: 70, color: i === 2 ? C.mint : '#a6573d'}}>{icon}</div>
              <div style={{padding: '16px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline'}}><span style={{fontFamily: F.body, fontWeight: 600, fontSize: 30, color: C.ink}}>📎 {name}</span><span style={{fontFamily: F.mono, fontSize: 22, color: '#8a8579'}}>{size}</span></div>
            </div>
          </Pop>
        ))}
      </div>
      <div style={at(120, 860, {width: 1680, display: 'flex', alignItems: 'center', gap: 18, background: '#fffdf8', border: '2px solid #ddd3c6', borderRadius: 50, padding: '18px 18px 18px 30px', fontFamily: F.body, fontSize: 40, boxSizing: 'border-box'})}>
        <span style={{flex: 1, color: C.ink}}>{typed('Why does checkout break here?', f, 16, 1.5) || ' '}</span>
        <span style={{width: 76, height: 76, borderRadius: '50%', background: '#a6573d', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 38, transform: `scale(${f >= 40 && f < 46 ? 0.86 : 1})`}}>↑</span>
      </div>
    </Scene>
  );
};

// ---------- 7. NEW: switch models ----------
const MODELS = ['Sonnet 5.5', 'Opus 5.5', 'Haiku 5.5'];
const Models: React.FC = () => {
  const f = useF();
  const pick = f < 30 ? Math.floor(f / 6) % 3 : 1;
  return (
    <Scene>
      <div style={at(120, 330, {width: 980})}><Caption isNew eyebrow="Models" title="Switch models mid-chat." sub="Pick one for an open Claude session. Shed switches it, then sends your message." /></div>
      <div style={at(1080, 220, {width: 560, transform: 'scale(1.25)', transformOrigin: 'top left'})}>
        <div style={{display: 'inline-flex', alignItems: 'center', gap: 10, border: '2px solid #a6573d', borderRadius: 999, background: '#f5e7df', padding: '12px 24px', fontFamily: F.body, fontWeight: 600, fontSize: 30, color: C.ink}}>✦ {MODELS[pick]}</div>
        <div style={{marginTop: 16, background: '#fffdf8', border: '2px solid #ddd3c6', borderRadius: 20, overflow: 'hidden', boxShadow: '0 24px 50px #0006'}}>
          {MODELS.map((m, i) => <div key={m} style={{padding: '20px 26px', fontFamily: F.body, fontSize: 30, color: C.ink, background: i === pick ? '#f5e7df' : 'transparent', borderTop: i ? '2px solid #efe8dc' : 'none'}}>{i === pick ? '✓ ' : '   '}{m}</div>)}
        </div>
        {f >= 32 && <Slide at={32}><div style={{marginTop: 22, fontFamily: F.mono, fontSize: 26, color: C.mint}}>❯ /model opus</div></Slide>}
      </div>
    </Scene>
  );
};

// ---------- 8. NEW: sessions talk to each other ----------
const Talk: React.FC = () => {
  const f = useF();
  const ask = ease(f, 26, 50), back = ease(f, 70, 92);
  const codexWorking = f >= 50 && f < 92;
  const answered = f >= 92;
  const line = f < 60 ? 0 : 1;
  const titles = ['Your agents talk to each other.', 'And you see every word.'];
  const dot = (t: number, from: number, to: number) => ({left: interpolate(t, [0, 1], [from, to]), top: 470 - Math.sin(t * Math.PI) * 120});
  const a = dot(ask, 560, 1340), b = dot(back, 1340, 560);
  return (
    <Scene>
      <div style={at(120, 60, {width: 1700})}>
        <Eyebrow><NewTag />Sessions talk</Eyebrow>
        <div style={{position: 'relative', height: 110, marginTop: 14}}>
          {titles.map((t, i) => <div key={t} style={{position: 'absolute', inset: 0, opacity: i === line ? 1 : 0}}><Headline size={86}>{t}</Headline></div>)}
        </div>
      </div>
      <div style={at(240, 270, {width: 340})}><DeskCard agent="claude" mood={f < 50 || answered ? 'working' : 'open'} project="web-app" harness="Claude Code" frame={f} seed={1} /></div>
      <div style={at(1340, 270, {width: 340})}><DeskCard agent="codex" mood={codexWorking ? 'working' : 'open'} project="orders-api" harness="Codex" frame={f} seed={3} /></div>
      <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}><path d="M600 470 Q 950 300 1330 470" stroke={C.mint} strokeWidth={4} strokeDasharray="6 14" fill="none" opacity={0.35} /></svg>
      {f >= 26 && f < 52 && <div style={{position: 'absolute', ...a, width: 24, height: 24, background: C.mint, boxShadow: `0 0 30px ${C.mint}`}} />}
      {f >= 70 && f < 94 && <div style={{position: 'absolute', ...b, width: 24, height: 24, background: C.roof, boxShadow: `0 0 30px ${C.roof}`}} />}
      <div style={at(170, 560, {width: 760})}>
        <TerminalWindow title="web-app · claude" fontSize={24}>
          <div style={{color: C.cream}}>{typed('$ shed ask orders-api "Which port does the API use?"', f, 4, 2.6)}</div>
          {f >= 30 && <div style={{color: '#7d8b82'}}>Sent. Waiting for its answer…</div>}
          {answered && <div style={{color: C.mint}}>{typed('4378, and it needs the X-Shop header.', f, 92, 2.4)}</div>}
        </TerminalWindow>
      </div>
      <div style={at(1000, 560, {width: 760})}>
        {f >= 50 && <Slide at={50}><TerminalWindow title="orders-api · codex" fontSize={24}>
          <div style={{color: C.roof}}>↔ From Claude · web-app</div>
          <div style={{color: C.cream}}>Which port does the API use?</div>
          {f >= 62 && <div style={{color: C.mint}}>{typed('• 4378, and it needs the X-Shop header.', f, 62, 2.4)}</div>}
        </TerminalWindow></Slide>}
      </div>
      {f >= 96 && <Slide at={96} style={at(170, 860, {width: 1590})}>
        <div style={{background: '#fffdf8', border: '2px solid #e3dccf', borderRadius: 18, padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 18, fontFamily: F.body, fontSize: 24, color: C.ink}}>
          <b style={{fontFamily: F.display}}>Between sessions</b>
          <span>✳ web-app <span style={{color: '#a6573d', fontWeight: 700}}>→</span> ◇ orders-api</span>
          <span style={{fontFamily: F.mono, fontSize: 18, color: '#466e58'}}>ANSWERED</span>
          <span style={{color: '#7a766d', marginLeft: 'auto'}}>↳ 4378, and it needs the X-Shop header.</span>
        </div>
      </Slide>}
    </Scene>
  );
};

// ---------- 9. files ----------
const Files: React.FC = () => {
  const f = useF();
  return (
    <Scene>
      <div style={at(120, 360, {width: 860})}><Caption eyebrow="Files" title="Grab what it made." sub="Videos, images and PDFs, previewed and one tap to download." /></div>
      <div style={at(1040, 280, {width: 760, transform: 'scale(1.08)', transformOrigin: 'top left', background: C.paper, borderRadius: 26, padding: 26, boxShadow: '0 40px 80px #000a'})}>
        {[['▶', 'launch-reel.mp4', '18.2 MB · now', '#f5e7df', '#a6573d'], ['▣', 'landing.png', '240 KB · 2m ago', '#e5efe9', '#466e58'], ['▤', 'report.pdf', '96 KB · 5m ago', '#ece8f6', '#6b5aa6']].map(([icon, name, meta, bg, fg], i) => (
          <Pop key={name} at={i * 4}>
            <div style={{display: 'flex', alignItems: 'center', gap: 16, padding: '16px 0', borderBottom: '2px solid #ebe5da'}}>
              <span style={{width: 60, height: 60, borderRadius: 12, background: bg, color: fg, display: 'grid', placeItems: 'center', fontSize: 26}}>{icon}</span>
              <div style={{flex: 1}}><div style={{fontFamily: F.body, fontWeight: 600, fontSize: 26, color: C.ink}}>{name}</div><div style={{fontFamily: F.mono, fontSize: 18, color: '#8a8579'}}>{meta}</div></div>
              <span style={{fontFamily: F.body, fontWeight: 600, fontSize: 20, color: i === 0 && f >= 24 ? '#fff' : '#a6573d', background: i === 0 && f >= 24 ? '#466e58' : 'transparent', border: '2px solid #e3d3c6', borderRadius: 10, padding: '9px 16px', transform: `scale(${i === 0 && f >= 20 && f < 26 ? 0.9 : 1})`}}>{i === 0 && f >= 24 ? '✓ Saved' : 'Download'}</span>
            </div>
          </Pop>
        ))}
      </div>
    </Scene>
  );
};

// ---------- 10. NEW: idle sessions close themselves ----------
const IDLE = [['claude', 'old-spike', true], ['codex', 'pricing-test', true], ['claude', 'web-app', false], ['gemini', 'logs', true], ['codex', 'orders-api', false], ['claude', 'notes', true]] as const;
const AutoClose: React.FC = () => {
  const f = useF();
  const hours = Math.min(12, Math.floor(ease(f, 0, 26, 0, 12.99)));
  return (
    <Scene>
      <div style={at(120, 90, {width: 1000})}><Caption isNew eyebrow="Tidy desk" title="Idle sessions close themselves." sub="12 hours with nothing happening, and the session and its Terminal window close. Busy ones never do." size={80} /></div>
      <div style={at(1260, 90, {fontFamily: F.pixel, fontSize: 96, color: hours >= 12 ? C.roof : C.cream})}>{hours}h<span style={{fontSize: 34, color: C.muted, marginLeft: 12}}>idle</span></div>
      <div style={at(120, 520, {width: 1680, display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 22})}>
        {IDLE.map(([agent, project, idle], i) => {
          const closeAt = 30 + i * 5;
          const k = idle ? ease(f, closeAt, closeAt + 8) : 0;
          return (
            <div key={project} style={{transform: `scale(${1 - k}) rotate(${k * 8}deg)`, opacity: 1 - k}}>
              <div style={{background: C.term, border: `2px solid ${idle ? C.line : C.mint}`, borderRadius: 14, overflow: 'hidden'}}>
                <div style={{padding: '8px 12px', borderBottom: `2px solid ${C.line}`, fontFamily: F.mono, fontSize: 15, color: C.muted}}>● ● ● {project}</div>
                <div style={{display: 'grid', placeItems: 'center', padding: '18px 0'}}><Agent name={agent} mood={idle ? 'open' : 'working'} size={150} frame={f} seed={i} /></div>
                <div style={{padding: '0 12px 12px', fontFamily: F.mono, fontSize: 15, color: idle ? '#7d8b82' : C.mint}}>{idle ? 'idle 12h' : 'working'}</div>
              </div>
            </div>
          );
        })}
      </div>
    </Scene>
  );
};

// ---------- 11. notifications ----------
const NOTES = [['Claude finished: Fix the flaky login test', 'The login test is stable now. 14 passed.'], ['Codex finished: Add pagination', 'Cursor and limit params, docs updated.'], ['Claude needs your OK', 'bakery-site: run npm install?']];
const Pings: React.FC = () => {
  const f = useF();
  return (
    <Scene>
      <div style={at(120, 360, {width: 860})}><Caption eyebrow="Notifications" title="Pinged when it’s done." sub="Close the app. Shed tells you when an agent finishes or needs you." /></div>
      <div style={at(1020, 290, {width: 780, display: 'grid', gap: 22})}>
        {NOTES.map(([title, body], i) => (
          <Slide key={title} at={i * 8} dy={-50}>
            <div style={{background: '#fbfaf7f2', borderRadius: 26, padding: '18px 22px', boxShadow: '0 18px 40px #0007', display: 'flex', gap: 16, alignItems: 'center'}}>
              <ShedLogo size={60} frame={f} />
              <div style={{fontFamily: F.body, color: C.ink}}><div style={{fontWeight: 600, fontSize: 24}}>{title}</div><div style={{fontSize: 20, color: '#625f57'}}>{body}</div></div>
            </div>
          </Slide>
        ))}
      </div>
    </Scene>
  );
};

// ---------- 12. rapid words ----------
const WORDS: [string, string][] = [['Private.', C.cream], ['Routed on your Mac.', C.mint], ['Every agent.', C.cream], ['Open source.', C.roof], ['Free.', C.mint]];
const Words: React.FC = () => {
  const f = useCurrentFrame();
  const i = Math.min(WORDS.length - 1, Math.floor(f / 16));
  const local = f - i * 16;
  const [word, color] = WORDS[i];
  return (
    <AbsoluteFill style={{background: i % 2 ? '#0e1411' : C.night, display: 'grid', placeItems: 'center'}}>
      <div style={{fontFamily: F.display, fontWeight: 800, fontSize: 190, letterSpacing: '-0.04em', color, transform: `scale(${interpolate(local, [0, 5], [1.12, 1], {extrapolateRight: 'clamp'})})`}}>{word}</div>
    </AbsoluteFill>
  );
};

// ---------- 13. outro ----------
const Outro: React.FC = () => {
  const f = useF();
  return (
    <Scene>
      <AbsoluteFill style={{display: 'grid', placeItems: 'center'}}>
        <div style={{display: 'grid', justifyItems: 'center', gap: 30}}>
          <Pop at={0} from={1.3}><ShedLogo size={250} frame={f} rowsShown={Math.floor(ease(f, 0, 18, 0, 15))} /></Pop>
          <Slide at={10}><div style={{fontFamily: F.display, fontWeight: 800, fontSize: 150, letterSpacing: '-0.04em', color: C.cream, lineHeight: 0.9}}>Shed</div></Slide>
          <Slide at={16}><div style={{fontFamily: F.display, fontWeight: 800, fontSize: 60, color: C.roof}}>Your desk, in your pocket.</div></Slide>
          <Slide at={24}><Eyebrow>Open source · Runs on your Mac · Powered by Laya</Eyebrow></Slide>
        </div>
      </AbsoluteFill>
    </Scene>
  );
};

// Cut list: [scene, length in frames at 30fps, animation speed]. Hard cuts, no crossfades. Each feature holds
// for about 3–5 seconds after its animation, long enough to say what it does.
const CUTS: [React.FC, number, number][] = [
  [HookAgents, 40, 1], [HookShed, 55, 1], [Message, 130, 1.5], [RealTerminal, 100, 1.5], [Approve, 110, 1.5],
  [Share, 150, 1.5], [Attach, 110, 1.5], [Models, 105, 1.5], [Talk, 210, 1.5], [Files, 95, 1.5], [AutoClose, 140, 1.5],
  [Pings, 100, 1.5], [Words, 80, 1], [Outro, 110, 1],
];
export const REEL_FRAMES = CUTS.reduce((sum, [, n]) => sum + n, 0);

export const ShedReel: React.FC = () => {
  useFonts();
  let from = 0;
  return (
    <AbsoluteFill style={{background: C.night}}>
      {CUTS.map(([Cut, n, speed], i) => {
        const seq = <Sequence key={i} from={from} durationInFrames={n}><Speed.Provider value={speed}><Cut /></Speed.Provider></Sequence>;
        from += n;
        return seq;
      })}
    </AbsoluteFill>
  );
};
