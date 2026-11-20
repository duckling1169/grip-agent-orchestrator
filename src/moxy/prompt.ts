import type { MessageAttachment } from '../contracts/attachments.js'
import type { ReceivedItem, WorkerTurnEnded } from './store.js'

export const WORKER_OUTPUT_EXCERPT = 1500

const INBOX_HEADING = '\n\n[Current inbox]\n'

export function withContext(context: string, inbox: string): string {
  return context ? `${context}${INBOX_HEADING}${inbox}` : inbox
}

export function inboxPart(message: string): string {
  return message.split(INBOX_HEADING).at(-1) ?? message
}

export function renderInbox(items: readonly ReceivedItem[]): string {
  const users = items.filter(item => item.kind === 'user_message')
  const events = items.filter(item => item.kind === 'worker_turn_ended')
  const followUps = items.filter(item => item.kind === 'follow_up')
  const sections = [
    ...users.map(item => renderUserMessage(item.body)),
    ...events.map(item => workerEvent(item.body)),
    ...followUps.map(item => `[moxy follow-up ${item.body.id}, due ${item.body.dueAt}]\n${item.body.prompt}`),
  ]
  const redelivered = items.some(item => item.interruptedDeliveries > 0)
  if (redelivered) {
    sections.push(
      '[moxy] Your last turn was interrupted before it finished, so some of this was delivered before. Check the workers before you repeat any action.',
    )
  }
  return sections.join('\n\n')
}

export function renderUserMessage({ text, attachments }: { text: string; attachments?: readonly MessageAttachment[] }): string {
  if (!attachments?.length) return text
  const files = attachments.map(file => `- ${file.path} (${file.type}, ${file.size} bytes)`)
  return `${text ? `${text}\n\n` : ''}Attachments:\n${files.join('\n')}`
}

function workerEvent(event: WorkerTurnEnded): string {
  const task = event.taskId ? ` (task ${event.taskId})` : ''
  const header = `[moxy] Worker ${event.workerId} "${event.title}"${task} ${event.status} turn ${event.turn}.`
  const lines = [header]
  if (event.error) lines.push(`Error: ${event.error}`)
  if (event.output) {
    const excerpt = event.output.length > WORKER_OUTPUT_EXCERPT ? `${event.output.slice(0, WORKER_OUTPUT_EXCERPT)}…` : event.output
    lines.push(`Output:\n${excerpt}`)
  }
  lines.push(`Read it in full with result ${event.workerId}.`)
  return lines.join('\n')
}
