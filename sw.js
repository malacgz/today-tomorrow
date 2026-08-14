// 今天和明天 Service Worker
const CACHE_NAME = 'today-tomorrow-v2';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];

// Install: cache app shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for HTML, cache-first for assets
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Navigation requests: network-first (always get latest UI)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Static assets: cache-first
  e.respondWith(
    caches.match(req).then(cached => {
      return cached || fetch(req).then(res => {
        if (res.ok && (req.url.includes('icon.svg') || req.url.includes('manifest.json'))) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});

// Push notifications — receives from push-server.js
self.addEventListener('push', (e) => {
  let data = { title: '今天和明天', body: '提醒', icon: 'icon.svg', badge: 'icon.svg' };
  try { data = JSON.parse(e.data.text()); } catch(err) { try{ data.body = e.data.text(); }catch(_){} }
  
  const tag = data.tag || 'today-tomorrow';
  
  e.waitUntil(
    self.registration.showNotification(data.title || '今天和明天', {
      body: data.body || '',
      icon: data.icon || 'icon.svg',
      badge: data.badge || 'icon.svg',
      tag: tag,
      requireInteraction: data.requireInteraction || false,
      vibrate: [200, 100, 200],
      data: { url: data.data?.url || '/' }
    })
  );
});

// Notification click: open app
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./index.html');
    })
  );
});