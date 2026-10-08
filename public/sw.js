// Shed's service worker: shows push notifications and opens the right session or task when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
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
