import { createHmac, timingSafeEqual } from 'node:crypto'

const PREFIX = 'grip-chat'

/**
 * The bearer token a Grip chat uses for Grip's MCP: its chat id, signed with the install's MCP
 * token. Grip keeps no list of them; it checks the signature, and every call is tied to the chat.
 */
export function chatToken(secret: string, chatId: string): string {
  return `${PREFIX}.${chatId}.${sign(secret, chatId)}`
}

/** The chat a token belongs to, or null if it is not a valid chat token. */
export function chatOfToken(secret: string, token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX) return null
  const [, chatId, given] = parts as [string, string, string]
  const expected = Buffer.from(sign(secret, chatId))
  const actual = Buffer.from(given)
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? chatId : null
}

function sign(secret: string, chatId: string): string {
  return createHmac('sha256', secret).update(`chat:${chatId}`).digest('hex')
}
