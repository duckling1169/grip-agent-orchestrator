import type { ConversationEntry, Task } from '../contracts/api.js'
import { MEMORY_LIMITS } from './memory.js'
import type { UserMemory } from './memory.js'
import { renderUserMessage } from './prompt.js'

type HandoffInput = { tasks: readonly Task[]; conversation: readonly ConversationEntry[]; memory: UserMemory }

export function handoffContext(input: HandoffInput, currentTurnId: number): string {
  return [
    'This is historical context for a fresh session, not a new request. Current inbox items govern this turn; history alone does not authorize accepting a task. Read full task records with task_get.',
    `User preferences:\n${clipped(input.memory.preferences, MEMORY_LIMITS.preferences) || '(none saved)'}`,
    `Open tasks:\n${taskContext(input.tasks)}`,
    `Recent conversation:\n${conversationContext(input.conversation, currentTurnId)}`,
  ].join('\n\n')
}

function taskContext(tasks: readonly Task[]): string {
  const open = tasks.filter(task => task.status !== 'done')
  const included: { task: Task; pointer: string }[] = []
  let pointerLength = 0
  for (const task of open.slice(0, 30)) {
    const pointer = `Task ${task.id} (${task.status})\nRepo: ${task.repoRoot ?? '(no repo)'}\nTitle: ${clipped(task.title, 160)}`
    if (pointerLength + pointer.length > 6000) continue
    included.push({ task, pointer })
    pointerLength += pointer.length
  }
  if (!included.length) return open.length ? '[Task context clipped; use tasks and task_get for full records.]' : '(no open tasks)'
  const omitted = open.length - included.length
  const notice = omitted ? `\n[${omitted} open tasks omitted; context clipped. Use tasks and task_get for full records.]` : ''
  const fieldLimit = Math.max(0, Math.floor(((12000 - pointerLength - notice.length - 128) / included.length - 40) / 3))
  const text = included
    .map(({ task, pointer }) =>
      [
        pointer,
        `Plan: ${clipped(task.plan, fieldLimit)}`,
        `Notes: ${clipped(task.notes, fieldLimit)}`,
        `Testing: ${clipped(task.testing, fieldLimit)}`,
      ].join('\n'),
    )
    .join('\n\n')
  return `${text}${notice}`
}

function conversationContext(conversation: readonly ConversationEntry[], currentTurnId: number): string {
  const historical = conversation.filter(entry =>
    entry.type === 'user'
      ? entry.leaderTurnId !== null && entry.leaderTurnId < currentTurnId
      : entry.turn.id < currentTurnId && entry.turn.status !== 'running' && (entry.turn.output !== null || entry.turn.error !== null),
  )
  const recent = historical.slice(-20)
  const messages: string[] = []
  let remaining = 7900
  for (const entry of [...recent].reverse()) {
    const prefix = entry.type === 'user' ? 'User: ' : `Moxy (${entry.turn.engine}, ${clipped(entry.turn.model ?? 'default', 120)}): `
    const content = entry.type === 'user' ? renderUserMessage(entry) : (entry.turn.output ?? `Turn failed: ${entry.turn.error}`)
    const message = `${prefix}${clipped(content, Math.max(0, Math.min(2000 - prefix.length, remaining - prefix.length)))}`
    if (remaining < 100) break
    messages.unshift(message)
    remaining -= message.length + 2
  }
  const omitted = historical.length > messages.length
  return `${omitted ? '[Older conversation clipped.]\n' : ''}${messages.join('\n\n') || '(no historical messages)'}`
}

function clipped(text: string, limit: number): string {
  if (text.length <= limit) return text
  const marker = '\n[clipped]\n'
  if (limit <= marker.length) return marker.slice(0, Math.max(0, limit))
  const available = limit - marker.length
  const beginning = Math.ceil(available / 2)
  const ending = available - beginning
  return `${text.slice(0, beginning)}${marker}${ending ? text.slice(-ending) : ''}`
}
