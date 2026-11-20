import { HttpError } from '../http.js'

export function routeError(error: unknown, path: string): HttpError | undefined {
  if (error instanceof HttpError) return error.status < 500 ? error : undefined
  if (!(error instanceof Error)) return
  const message = error.message
  if (
    (path.startsWith('/api/tasks/') && /^unknown task [\w-]+$/.test(message)) ||
    (path.startsWith('/api/workers/') && /^unknown worker [\w-]+$/.test(message)) ||
    (path === '/api/leader/retry' && /^unknown leader turn -?\d+$/.test(message))
  )
    return new HttpError(404, message)
  if (
    (path === '/api/leader/retry' &&
      /^leader turn -?\d+ is (?:already retried|running|finished|stopped|interrupted); only a failed turn can be retried$/.test(message)) ||
    (path.startsWith('/api/workers/') &&
      path.endsWith('/message') &&
      /^worker [\w-]+ is still (?:finishing its last turn|working; wait for it or stop it first)$/.test(message)) ||
    (path === '/api/push/subscribe' &&
      ['Invalid push subscription', 'This push subscription belongs to another login', 'Push device limit reached'].includes(message))
  )
    return new HttpError(400, message)
}
