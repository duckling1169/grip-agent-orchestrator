// Caches the app shell only (the page, its hashed assets and icons), so the app still opens when
// the machine that served it is off and another machine's Grip can be chosen (DESIGN §12). The
// shell holds no user data. API calls, /health and every other origin are never cached.
const CACHE = 'grip-shell'
const SHELL = ['/', '/icon.svg', '/manifest.webmanifest', '/icons/grip-192.png', '/icons/grip-512.png']

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event =>
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  ),
)

const isShell = url => SHELL.includes(url.pathname) || url.pathname.startsWith('/assets/')

/** Keep only the hashed assets the current page uses. */
async function prune(cache, html) {
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname
    if (path.startsWith('/assets/') && !html.includes(path)) await cache.delete(request)
  }
}

async function navigate(request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) {
      const html = await response.clone().text()
      await cache.put('/', response.clone())
      await prune(cache, html)
    }
    return response
  } catch {
    return (await cache.match('/')) ?? offlinePage()
  }
}

async function asset(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  if (event.request.mode === 'navigate') return event.respondWith(navigate(event.request))
  if (isShell(url)) event.respondWith(asset(event.request))
})

function offlinePage() {
  return new Response(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grip is offline</title><body style="background:#151719;color:#edece8;font:16px system-ui;max-width:32rem;margin:15vh auto;padding:24px"><h1>Grip is offline</h1><p>This machine may be asleep or disconnected. Reconnect to your tailnet and try again.</p><button onclick="location.reload()" style="font:inherit;padding:12px 20px;cursor:pointer">Reconnect to Grip</button></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  )
}
