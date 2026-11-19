import type { ReceivedItem, WorkerTurnEnded } from './store.js'

export const WORKER_OUTPUT_EXCERPT = 1500

export function renderInbox(items: readonly ReceivedItem[]): string {
  const users = items.filter(item => item.kind === 'user_message')
  const events = items.filter(item => item.kind === 'worker_turn_ended')
  const sections = [...users.map(item => item.body.text), ...events.map(item => workerEvent(item.body))]
  const redelivered = items.some(item => item.interruptedDeliveries > 0)
  if (redelivered) {
    sections.push(
      '[moxy] Your last turn was interrupted before it finished, so some of this was delivered before. Check the workers before you repeat any action.',
    )
  }
  return sections.join('\n\n')
}

function workerEvent(event: WorkerTurnEnded): string {
  const header = `[moxy] Worker ${event.workerId} "${event.title}" ${event.status} turn ${event.turn}.`
  const lines = [header]
  if (event.error) lines.push(`Error: ${event.error}`)
  if (event.output) {
    const excerpt = event.output.length > WORKER_OUTPUT_EXCERPT ? `${event.output.slice(0, WORKER_OUTPUT_EXCERPT)}…` : event.output
    lines.push(`Output:\n${excerpt}`)
  }
  lines.push(`Read it in full with result ${event.workerId}.`)
  return lines.join('\n')
}
