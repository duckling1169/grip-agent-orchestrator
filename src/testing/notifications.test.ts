import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

async function worker() {
  const listeners = new Map<string, (event: unknown) => void>()
  const shown: { title: string; options: Record<string, unknown> }[] = []
  const opened: string[] = []
  const navigated: string[] = []
  let focused = 0
  const windows = [
    {
      url: 'https://moxy.example/',
      focus: async () => {
        focused++
        return windows[0]
      },
      navigate: async (url: string) => {
        navigated.push(url)
      },
    },
  ]
  const self = {
    location: { origin: 'https://moxy.example' },
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    skipWaiting: async () => {},
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options })
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url)
      },
    },
  }
  runInNewContext(await readFile(new URL('../../web/public/sw.js', import.meta.url), 'utf8'), { self, URL })
  const dispatch = async (name: string, event: object) => {
    let pending = Promise.resolve()
    listeners.get(name)!({
      ...event,
      waitUntil: (work: Promise<void>) => {
        pending = work
      },
    })
    await pending
  }
  return { listeners, shown, opened, navigated, windows, focused: () => focused, dispatch }
}

describe('notification service worker', () => {
  it('shows only a title and safe task path, never payload body or output', async () => {
    const sw = await worker()
    await sw.dispatch('push', {
      data: { json: () => ({ title: 'Task ready', body: 'secret output', taskId: 'task 1', path: '/?task=task%201' }) },
    })
    expect(sw.shown).toEqual([{ title: 'Task ready', options: { tag: 'moxy-task-task 1', data: { path: '/?task=task%201' } } }])
    expect(sw.listeners.has('fetch')).toBe(false)
  })

  it('displays a fallback for malformed data and refuses external click paths', async () => {
    const sw = await worker()
    await sw.dispatch('push', {
      data: {
        json: () => {
          throw new Error('bad json')
        },
      },
    })
    expect(sw.shown[0]?.title).toBe('Moxy')
    await sw.dispatch('push', { data: { json: () => ({ title: 42, path: '//evil.example/path' }) } })
    expect(sw.shown[1]?.options.data).toEqual({ path: '/' })
    let closed = false
    await sw.dispatch('notificationclick', {
      notification: {
        close: () => {
          closed = true
        },
        data: { path: 'https://evil.example/' },
      },
    })
    expect(closed).toBe(true)
    expect(sw.navigated).toEqual(['https://moxy.example/'])
    expect(sw.opened).toEqual([])
  })

  it('reuses a same-origin window or opens the task when no window exists', async () => {
    const sw = await worker()
    const event = { notification: { close: () => {}, data: { path: '/?task=abc' } } }
    await sw.dispatch('notificationclick', event)
    expect(sw.focused()).toBe(1)
    expect(sw.navigated).toEqual(['https://moxy.example/?task=abc'])
    sw.windows.splice(0)
    await sw.dispatch('notificationclick', event)
    expect(sw.opened).toEqual(['https://moxy.example/?task=abc'])
  })
})
