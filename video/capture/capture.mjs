// Captures the real Shed web app, screen by screen, for the product reel. The page and its code are the real thing,
// served by the running Shed; only the data is a demo set (so no real sessions or paths appear in a public video).
// Run: node video/capture/capture.mjs   (Shed must be running on 127.0.0.1:4378)
import { chromium } from '/Users/techie007/animations/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demo } from './demo-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'public', 'product');
fs.mkdirSync(out, { recursive:true });
const BASE = 'http://127.0.0.1:4378';
const shots = {};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const browser = await chromium.launch();

// The bakery landing page an agent "made", used for the image preview in the Files tab.
const art = await browser.newPage({ viewport:{ width:1200, height:800 } });
await art.setContent(`<body style="margin:0;font-family:Georgia,serif;background:linear-gradient(135deg,#f4d7b5,#e9b98c);height:800px;position:relative">
  <div style="background:#5b3a24;color:#fff3e2;padding:26px 40px;font:800 40px system-ui;display:flex">Rise Bakery<span style="margin-left:auto;font:500 24px system-ui">Tue–Sun · 7am–3pm</span></div>
  <div style="padding:90px 60px;color:#4a2e1c"><div style="font:800 96px/1 system-ui">Fresh sourdough<br>every morning</div>
  <div style="margin-top:40px;font:400 32px system-ui">Today: cardamom buns, rye loaf, plum tart</div>
  <div style="margin-top:44px;display:inline-block;background:#a6573d;color:#fff;font:600 30px system-ui;border-radius:14px;padding:20px 32px">Order for pickup</div></div></body>`);
const landingPng = await art.screenshot();
await art.close();

// Laya stays out of this video: its name is hidden or reworded on every page as it renders.
const NO_LAYA = () => {
  const clean = () => {
    if (!document.body) return;
    document.querySelectorAll('.brand small, #router-status, .settings-card').forEach(el => { el.style.display = 'none'; });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) if (/laya/i.test(node.nodeValue)) node.nodeValue = node.nodeValue.replace(/✦ Laya chooses/g, '✦ Auto').replace(/Laya chooses/g, 'Shed chooses').replace(/local Laya/g, 'Shed').replace(/Laya/g, 'Shed');
    document.querySelectorAll('option').forEach(o => { if (/laya/i.test(o.textContent)) o.textContent = o.textContent.replace(/Laya chooses/g, 'Auto'); });
  };
  let queued = false;
  const schedule = () => { if (queued || !document.body) return; queued = true; setTimeout(() => { queued = false; clean(); }, 0); };
  new MutationObserver(schedule).observe(document, { childList:true, subtree:true, characterData:true });
  document.addEventListener('DOMContentLoaded', schedule);
};
async function mock(page, state) {
  await page.addInitScript(NO_LAYA);
  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const res = demo.respond(state, req.method(), url.pathname, url.searchParams, req.postData());
    if (res === 'events') return route.fulfill({ status:200, headers:{ 'content-type':'text/event-stream' }, body:': demo\n\n' });
    if (res === 'landing') return route.fulfill({ status:200, headers:{ 'content-type':'image/png' }, body:landingPng });
    return route.fulfill({ status:res.status || 200, headers:{ 'content-type':'application/json' }, body:JSON.stringify(res.body) });
  });
}
async function box(page, selector) {
  const b = await page.locator(selector).first().boundingBox();
  return b ? { x:Math.round(b.x + b.width / 2), y:Math.round(b.y + b.height / 2), w:Math.round(b.width), h:Math.round(b.height) } : null;
}
async function shot(page, name, taps = {}) {
  await page.screenshot({ path:path.join(out, `${name}.png`) });
  const viewport = page.viewportSize();
  shots[name] = { file:`product/${name}.png`, width:viewport.width, height:viewport.height, taps };
  console.log('captured', name);
}

// ---------- phone ----------
{
  const state = demo.state();
  const ctx = await browser.newContext({ viewport:{ width:390, height:844 }, deviceScaleFactor:3, isMobile:true, hasTouch:true });
  const page = await ctx.newPage();
  await mock(page, state);
  page.on('pageerror', e => console.error('page error:', e.message));

  await page.goto(BASE + '/'); await wait(2500);
  await shot(page, 'p-home', { input:await box(page, '#phone-message-input') });

  await page.locator('#phone-message-input').click();
  await page.locator('#phone-message-input').pressSequentially('Fix the flaky login test', { delay:20 });
  await wait(400);
  await shot(page, 'p-typed', { send:await box(page, '#phone-message button[type=submit]') });
  await page.locator('#phone-message button[type=submit]').click(); await wait(2200);
  await shot(page, 'p-sent');

  await page.goto(BASE + '/?session=' + encodeURIComponent('claude:mobile')); await wait(2200);
  await page.locator('#drawer-tabs [data-pane=terminal]').click(); await wait(2500);
  await shot(page, 'p-asking', { yes:await box(page, '#terminal-choices [data-option="0"]') });
  state.approved = true;
  await wait(3500);
  await shot(page, 'p-approved');

  await page.goto(BASE + '/?session=' + encodeURIComponent('claude:bakery')); await wait(2800);
  await shot(page, 'p-chat');
  await page.locator('#drawer-tabs [data-pane=files]').click(); await wait(1500);
  await shot(page, 'p-files', { preview:await box(page, '[data-preview="1"]') });
  await page.locator('[data-preview="1"]').click(); await wait(1200);
  await shot(page, 'p-files-preview', { download:await box(page, '.file-row:nth-child(2) .file-download') });

  await page.goto(BASE + '/'); await wait(2200);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-attach="phone"]').click();
  await (await chooser).setFiles([
    { name:'checkout-bug.png', mimeType:'image/png', buffer:landingPng },
    { name:'spec.pdf', mimeType:'application/pdf', buffer:Buffer.alloc(1100 * 1024) },
    { name:'repro.mov', mimeType:'video/quicktime', buffer:Buffer.alloc(3 * 1024 * 1024) },
  ]);
  await wait(1200);
  await page.locator('#phone-message-input').pressSequentially('Why does checkout break here?', { delay:15 });
  await wait(400);
  await shot(page, 'p-attach', { clip:await box(page, '[data-attach="phone"]') });

  await page.goto(BASE + '/'); await wait(2200);
  await page.selectOption('#phone-harness', 'claude'); await wait(300);
  await page.selectOption('#phone-model', 'opus'); await wait(300);
  await page.locator('#phone-message-input').pressSequentially('Review the payment flow for edge cases', { delay:10 });
  await wait(300);
  await shot(page, 'p-model', { model:await box(page, '#phone-model'), harness:await box(page, '#phone-harness') });

  await page.goto(BASE + '/?session=' + encodeURIComponent('codex:api')); await wait(2800);
  await shot(page, 'p-talk-reply');
  await page.locator('#drawer-content').evaluate(el => { el.scrollTop = 0; }); await wait(600);
  await shot(page, 'p-talk-top');

  await page.goto(BASE + '/?session=' + encodeURIComponent('claude:web')); await wait(2500);
  await page.locator('#drawer-content').evaluate(el => { el.scrollTop = 0; }); await wait(400);
  await shot(page, 'p-talk-button', { talk:await box(page, '#open-talk') });
  await page.locator('#open-talk').click(); await wait(500);
  await page.selectOption('#talk-target', 'codex:api');
  await page.locator('#talk-note').pressSequentially('Agree on the checkout API shape before you change the client.', { delay:8 });
  await wait(300);
  await shot(page, 'p-talk-dialog', { send:await box(page, '#talk-send') });

  await page.goto(BASE + '/'); await wait(2200);
  await page.locator('#session-talk').scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, 120)); await wait(800);
  await shot(page, 'p-home-talk');

  await page.goto(BASE + '/?view=settings'); await wait(2200);
  await page.locator('#notify-settings').evaluate(el => el.scrollIntoView({ block:'start' })); await wait(800);
  await shot(page, 'p-settings-idle', { toggle:await box(page, '#autoclose-enabled') });
  await page.locator('#share-settings').evaluate(el => el.scrollIntoView({ block:'start' })); await page.evaluate(() => window.scrollBy(0, -70)); await wait(800);
  await shot(page, 'p-settings-share', { get:await box(page, '#share-get') });
  await ctx.close();
}

// ---------- desktop ----------
{
  const state = demo.state();
  const ctx = await browser.newContext({ viewport:{ width:1600, height:1000 }, deviceScaleFactor:1.5 });
  const page = await ctx.newPage();
  await mock(page, state);
  page.on('pageerror', e => console.error('page error:', e.message));
  // The phone-pairing card has no QR code with demo data, and a phone is already connected in this story.
  await page.addStyleTag({ content:'#connect-card{display:none!important}' }).catch(() => {});
  await page.goto(BASE + '/'); await wait(2800);
  await page.addStyleTag({ content:'#connect-card{display:none!important}' });
  await shot(page, 'd-home');
  await page.locator('#session-talk').scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, 200)); await wait(800);
  await shot(page, 'd-home-talk');
  await page.goto(BASE + '/?session=' + encodeURIComponent('codex:api')); await wait(2800);
  await page.addStyleTag({ content:'#connect-card{display:none!important}' });
  await shot(page, 'd-drawer-talk');
  await ctx.close();
}

await browser.close();
fs.writeFileSync(path.join(out, 'shots.json'), JSON.stringify(shots, null, 2));
console.log('wrote', Object.keys(shots).length, 'shots');
