import { useEffect, useState } from 'react'

import { api } from '@/lib/api'
import { errorText, note, outlineButton, settingHeading, settingRow } from '@/lib/styles'
import { disableNotifications, enableNotifications, notificationTestMessage, readNotificationState } from '@/lib/notifications'
import type { NotificationState } from '@/lib/notifications'

export function NotificationSettings({ offline }: { offline: boolean }) {
  const [state, setState] = useState<NotificationState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (offline) return
    let live = true
    readNotificationState(api).then(
      next => {
        if (live) {
          setState(next)
          setError(null)
        }
      },
      () => {
        if (live) setError('Could not read notification settings. Try refreshing the status.')
      },
    )
    return () => {
      live = false
    }
  }, [offline])

  const act = async (work: () => Promise<void>) => {
    if (offline || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await work()
    } catch (failure) {
      setState(null)
      try {
        setState(await readNotificationState(api))
      } catch {}
      setError(failure instanceof Error ? failure.message : 'Could not update notifications.')
    } finally {
      setBusy(false)
    }
  }
  const hasDeviceStatus = state && 'devices' in state
  return (
    <section aria-label="Notifications">
      <h2 className={settingHeading}>Notifications</h2>
      <p className={note}>Get a notification when Moxy finishes a task. Notifications contain titles only.</p>
      {offline ? (
        <p className={note}>Notification status unavailable while offline.</p>
      ) : !state && !error ? (
        <p className={note}>Checking notification status…</p>
      ) : state?.kind === 'unsupported' ? (
        <p className={note}>{state.reason}</p>
      ) : state?.kind === 'blocked' ? (
        <p className={note}>Notifications are blocked. Allow Moxy notifications in browser settings, then refresh the status.</p>
      ) : state?.kind === 'on' ? (
        <p className={note}>Notifications are enabled on this device.</p>
      ) : state?.kind === 'renew' ? (
        <p className={note}>Moxy’s notification key changed. Enable notifications again to renew this device.</p>
      ) : (
        state && <p className={note}>Notifications are off on this device.</p>
      )}
      <div className={settingRow}>
        <span className="flex-1">Your registered devices</span>
        <span>{offline || !hasDeviceStatus ? '—' : state.devices}</span>
      </div>
      <div className={settingRow}>
        {hasDeviceStatus && state.kind !== 'on' && (
          <button
            className={outlineButton}
            type="button"
            disabled={offline || busy}
            onClick={() =>
              void act(async () => {
                setState(await enableNotifications(api))
              })
            }
          >
            Enable notifications
          </button>
        )}
        {hasDeviceStatus && state.kind === 'on' && (
          <button
            className={outlineButton}
            type="button"
            disabled={offline || busy}
            onClick={() =>
              void act(async () => {
                setState(await disableNotifications(api))
              })
            }
          >
            Disable on this device
          </button>
        )}
        {hasDeviceStatus && (
          <button
            className={outlineButton}
            type="button"
            disabled={offline || busy || state.devices === 0}
            onClick={() =>
              void act(async () => {
                const report = await api.pushTest()
                setNotice(notificationTestMessage(report))
                if (report.errors.length) setError(`Push service errors: ${report.errors.join('; ')}`)
                setState(await readNotificationState(api))
              })
            }
          >
            Send notification test
          </button>
        )}
        <button
          className={outlineButton}
          type="button"
          disabled={offline || busy}
          onClick={() =>
            void act(async () => {
              setState(await readNotificationState(api))
            })
          }
        >
          Refresh notification status
        </button>
      </div>
      {notice && (
        <p className={note} role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className={errorText} role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
