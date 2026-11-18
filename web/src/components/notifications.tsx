import { useEffect, useId, useState } from 'react'

import { Button } from '@/components/ui/button'

import { pushApi } from '../api.js'
import type { PushEvent } from '../api.js'
import { ErrorBanner, touchButton, useAction } from './common.js'

const EVENT_LABELS: Record<PushEvent, string> = {
  'run-done': 'A worker finishes',
  'run-failed': 'A worker fails',
  'claw-rolled-back': 'A Claw update is rolled back',
  'principal-offline': 'This computer goes to sleep or shuts down',
}

type Status =
  | { kind: 'loading' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'blocked' }
  | { kind: 'off'; publicKey: string; events: PushEvent[] }
  | { kind: 'on'; publicKey: string; events: PushEvent[]; endpoint: string; muted: PushEvent[] }

const isAppleMobile = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const installed = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

function unsupportedReason(): string | null {
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return null
  if (isAppleMobile() && !installed())
    return 'On iPhone and iPad, add Grip to your Home Screen first (Share, then Add to Home Screen), and open it from there.'
  return "This browser can't receive notifications."
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'))
}

/** A subscription made for another key (Grip made new keys) can't receive this Grip's messages. */
function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey
  if (!key) return false
  const bytes = new Uint8Array(key)
  const wanted = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  return bytes.length === wanted.length && bytes.every((byte, i) => byte === wanted[i])
}

async function readStatus(): Promise<Status> {
  const reason = unsupportedReason()
  if (reason) return { kind: 'unsupported', reason }
  const info = await pushApi.info()
  if (!info) return { kind: 'unsupported', reason: "This Grip can't send notifications." }
  if (Notification.permission === 'denied') return { kind: 'blocked' }
  const subscription = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()
  const device = subscription && Notification.permission === 'granted' ? await pushApi.device(subscription.endpoint) : null
  return subscription && device && sameKey(subscription, info.publicKey)
    ? { kind: 'on', ...info, endpoint: subscription.endpoint, muted: device.muted }
    : { kind: 'off', ...info }
}

/**
 * Notifications for this device: turn them on, choose what to hear about, send a test, or turn
 * them off. Each device keeps its own choices on the machine that served the app.
 */
export function NotificationSettings() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [tested, setTested] = useState<string>()
  const action = useAction()
  const id = useId()

  useEffect(() => {
    let live = true
    readStatus().then(
      next => live && setStatus(next),
      () => live && setStatus({ kind: 'unsupported', reason: "Grip couldn't read this device's notification settings." }),
    )
    return () => {
      live = false
    }
  }, [])

  const turnOn = (publicKey: string, events: PushEvent[]) =>
    action.perform(async () => {
      // Asked only here, after a tap, as iOS requires.
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') return setStatus(permission === 'denied' ? { kind: 'blocked' } : { kind: 'off', publicKey, events })
      const manager = (await registration()).pushManager
      let subscription = await manager.getSubscription()
      if (subscription && !sameKey(subscription, publicKey)) {
        await subscription.unsubscribe()
        subscription = null
      }
      subscription ??= await manager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey })
      const device = await pushApi.subscribe(subscription.toJSON())
      setStatus({ kind: 'on', publicKey, events, endpoint: subscription.endpoint, muted: device.muted })
    })

  if (status.kind === 'loading') return <p className="text-muted-foreground">Checking this device…</p>
  if (status.kind === 'unsupported') return <p className="text-muted-foreground">{status.reason}</p>
  if (status.kind === 'blocked')
    return (
      <p className="text-muted-foreground">
        Notifications are blocked for Grip. Allow them in this browser's or this device's settings, then reopen Settings.
      </p>
    )

  if (status.kind === 'off')
    return (
      <div className="grid gap-2">
        <p className="text-muted-foreground">Get a notification on this device when a worker finishes or fails.</p>
        <div>
          <Button
            className={touchButton}
            type="button"
            variant="outline"
            disabled={action.busy}
            onClick={() => turnOn(status.publicKey, status.events)}
          >
            Turn on notifications
          </Button>
        </div>
        <ErrorBanner text={action.error} />
      </div>
    )

  const on = status
  const toggle = (event: PushEvent, wanted: boolean) =>
    action.perform(async () => {
      const muted = wanted ? on.muted.filter(item => item !== event) : [...on.muted, event]
      const device = await pushApi.setMuted(on.endpoint, muted)
      setStatus({ ...on, muted: device.muted })
    })
  return (
    <div className="grid gap-3">
      <fieldset className="grid gap-1" disabled={action.busy}>
        <legend className="mb-1 text-muted-foreground">Notify this device when</legend>
        {on.events.map(event => (
          <label key={event} htmlFor={`${id}-${event}`} className="flex min-h-11 cursor-pointer items-center gap-3 md:min-h-8">
            <input
              id={`${id}-${event}`}
              type="checkbox"
              className="size-4 accent-primary"
              checked={!on.muted.includes(event)}
              onChange={change => toggle(event, change.currentTarget.checked)}
            />
            {EVENT_LABELS[event]}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button
          className={touchButton}
          type="button"
          variant="outline"
          disabled={action.busy}
          onClick={() =>
            action.perform(async () => {
              setTested(undefined)
              const result = await pushApi.test()
              const reached = result.devices === 1 ? 'your device' : `${result.sent} of ${result.devices} devices`
              setTested(`Test sent to ${reached}.`)
              if (result.errors.length) throw new Error(`A push service refused it: ${result.errors.join('; ')}`)
            })
          }
        >
          Send a test to all devices
        </Button>
        <Button
          className={touchButton}
          type="button"
          variant="ghost"
          disabled={action.busy}
          onClick={() =>
            action.perform(async () => {
              await pushApi.unsubscribe(on.endpoint)
              await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription().then(sub => sub?.unsubscribe())
              setStatus({ kind: 'off', publicKey: on.publicKey, events: on.events })
            })
          }
        >
          Turn off on this device
        </Button>
      </div>
      {tested && (
        <p className="text-muted-foreground" role="status">
          {tested}
        </p>
      )}
      <ErrorBanner text={action.error} />
    </div>
  )
}
