// No caches: an authenticated UI must never serve another user's or a stale agent's data.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate' || new URL(event.request.url).origin !== self.location.origin) return
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grip is offline</title><body style="background:#151719;color:#edece8;font:16px system-ui;max-width:32rem;margin:15vh auto;padding:24px"><h1>Grip is offline</h1><p>Your principal machine may be asleep or disconnected. Reconnect to your tailnet and try again.</p><button onclick="location.reload()" style="font:inherit;padding:12px 20px;cursor:pointer">Reconnect to Grip</button></body></html>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
        ),
    ),
  )
})
