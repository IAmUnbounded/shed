import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

// Web Push: each phone that turns on notifications stores a subscription here; Shed signs pushes with its own VAPID keys.
let file = '';
let state = { keys:null, subscriptions:[] };

export function initPush(dataDir) {
  file = path.join(dataDir, 'push.json');
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  if (!state.keys) { state.keys = webpush.generateVAPIDKeys(); save(); }
  // Apple's push service rejects a localhost contact (403 BadJwtToken); the subject must be a real https or mailto address.
  webpush.setVapidDetails('https://github.com/IAmUnbounded/shed', state.keys.publicKey, state.keys.privateKey);
}
function save() { fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode:0o600 }); }

export const pushPublicKey = () => state.keys.publicKey;
export const pushCount = () => state.subscriptions.length;
export const isSubscribed = endpoint => state.subscriptions.some(s => s.endpoint === endpoint);

export function subscribe(subscription, label = '') {
  if (!subscription?.endpoint || !/^https:\/\//.test(subscription.endpoint) || !subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error('That is not a valid push subscription.');
  state.subscriptions = state.subscriptions.filter(s => s.endpoint !== subscription.endpoint);
  state.subscriptions.push({ endpoint:subscription.endpoint, keys:subscription.keys, label:String(label).slice(0, 80), createdAt:new Date().toISOString() });
  save();
}
export function unsubscribe(endpoint) {
  state.subscriptions = state.subscriptions.filter(s => s.endpoint !== endpoint);
  save();
}

// payload: { title, body, url, tag }. Subscriptions the push service reports as gone (404/410) are dropped.
export async function notify(payload, only = null) {
  const targets = only ? state.subscriptions.filter(s => s.endpoint === only) : state.subscriptions;
  const gone = [];
  await Promise.all(targets.map(async sub => {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL:3600, urgency:'high' }); }
    catch (error) { if ([404, 410].includes(error.statusCode)) gone.push(sub.endpoint); else console.error(`Push failed: ${error.statusCode || ''} ${error.body || error.message}`); }
  }));
  if (gone.length) { state.subscriptions = state.subscriptions.filter(s => !gone.includes(s.endpoint)); save(); }
  return targets.length - gone.length;
}
