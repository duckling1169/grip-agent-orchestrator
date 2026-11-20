export const MAX_ATTACHMENTS = 10
export const MAX_ATTACHMENT_MB = 25
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024

export type MessageAttachment = { id: string; name: string; type: string; size: number; path: string }
