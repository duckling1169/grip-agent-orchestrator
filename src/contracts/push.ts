export type PushSubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } }

export type PushStatus = { publicKey: string; devices: number; subscribed: boolean }

export type PushReport = { attempted: number; sent: number; failed: number; errors: string[] }

export type PushMessage = { title: string; path: string; taskId?: string }
