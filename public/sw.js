// Shed's service worker: shows push notifications and opens the right session or task when one is tapped.
// It also keeps the app's own files, so the app opens straight from the phone instead of waiting for the tunnel.
// The page itself (app.js) refreshes all of them together when the Mac runs a newer version; data (/api/) is never cached.
const SHELL_CACHE = 'shed-shell-v1', SHELL_FILES = ['/', '/app.js', '/markdown.js', '/styles.css', '/theme.css', '/logo.svg', '/manifest.webmanifest'];
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES)).catch(() => {}));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // An update fetches with cache: 'no-store'; those go straight to the Mac.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || ['no-store', 'reload'].includes(event.request.cache)) return;
  const key = event.request.mode === 'navigate' ? '/' : url.pathname;
  if (!SHELL_FILES.includes(key)) return;
  event.respondWith(caches.open(SHELL_CACHE).then(async cache => {
    const hit = await cache.match(key);
    if (hit) return hit;
    const response = await fetch(event.request);
    if (response.ok) cache.put(key, response.clone());
    return response;
  }));
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title:'Shed', body:event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Shed', {
    body:data.body || '',
    icon:'/icon-192.png',
    badge:'/icon-192.png',
    tag:data.tag,
    renotify:Boolean(data.tag),
    data:{ url:data.url || '/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    const open = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (open) { await open.focus(); open.postMessage({ type:'open', url }); return; }
    await self.clients.openWindow(url);
  })());
});
