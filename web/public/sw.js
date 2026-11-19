// Push display and window reuse adapted from Grip's web/public/sw.js.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

function safePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return '/'
  try {
    const target = new URL(path, self.location.origin)
    return target.origin === self.location.origin ? target.pathname + target.search + target.hash : '/'
  } catch {
    return '/'
  }
}

self.addEventListener('push', event => {
  let message
  try {
    message = event.data?.json()
  } catch {}
  if (!message || typeof message !== 'object') message = {}
  const title = typeof message.title === 'string' && message.title.trim() ? message.title.trim().slice(0, 200) : 'Moxy'
  const taskId = typeof message.taskId === 'string' ? message.taskId.slice(0, 200) : null
  const path = safePath(message.path ?? (taskId ? `/?task=${encodeURIComponent(taskId)}` : '/'))
  event.waitUntil(self.registration.showNotification(title, { tag: taskId ? `moxy-task-${taskId}` : 'moxy', data: { path } }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = new URL(safePath(event.notification.data?.path), self.location.origin)
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
      const open = windows.find(client => new URL(client.url).origin === target.origin)
      if (open) {
        await open.focus()
        return open.navigate(target.href)
      }
      return self.clients.openWindow(target.href)
    }),
  )
})
