import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startMoxy } from '../src/app.js'
import { userMessage } from '../src/moxy/store.js'
import type { LeaderReply, LeaderRunner } from '../src/runtime/leaders/leader.js'
import { TaskStore } from '../src/tasks/store.js'
import { WorkerStore } from '../src/workers/store.js'
import type { NewWorker } from '../src/workers/store.js'

const PREVIEW_PORT = 18799
const LOGIN = 'preview@example.com'
const REPLY_DELAY_MS = 4000
const FAKE_CLAW_CLI = fileURLToPath(new URL('../src/testing/fake-clawo.mjs', import.meta.url))

class PreviewLeader implements LeaderRunner {
  delayMs = 0
  private cancel: (() => void) | null = null

  run(request: { message: string }): Promise<LeaderReply> {
    return new Promise(resolve => {
      const reply = (output: string, error: string | null = null) => {
        this.cancel = null
        resolve({ output, error, nativeSessionId: 'preview' })
      }
      const timer = setTimeout(() => {
        if (/\bfail\b/i.test(request.message)) reply('', 'Claude usage limit reached; it resets at 16:00')
        else reply(previewReply(request.message))
      }, this.delayMs)
      this.cancel = () => {
        clearTimeout(timer)
        reply('', 'Stopped')
      }
    })
  }

  async stop(): Promise<void> {
    this.cancel?.()
  }
}

function previewReply(message: string): string {
  const quoted = (message.split('\n')[0] ?? '').slice(0, 80)
  return `Got it: “${quoted}”\n\nThis is the local preview, so no model ran. I would:\n\n- record it as a task\n- start a worker on it\n- tell you when it is ready to try`
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

const home = await mkdtemp(join(tmpdir(), 'moxy-web-preview-'))
const leader = new PreviewLeader()
const moxy = await startMoxy({
  home,
  clawPort: await freePort(),
  mcpPort: await freePort(),
  webPort: await freePort(),
  clawCli: FAKE_CLAW_CLI,
  leaders: () => leader,
  workspace: home,
  tailscaleOwner: async () => LOGIN,
  log: () => {},
})

const tasks = new TaskStore(moxy.database)
const workers = new WorkerStore(moxy.database)
const repoRoot = join(home, 'airport-sim')

function worker(id: string, fields: Partial<NewWorker> & Pick<NewWorker, 'title' | 'engine'>, input: string) {
  return workers.create({ id, taskId: null, model: null, effort: null, folder: repoRoot, cwd: repoRoot, repo: null, ...fields }, input)
}

function finish(id: string, status: 'finished' | 'failed' | 'interrupted', output: string | null, error: string | null = null) {
  workers.endTurn({ workerId: id, number: 1 }, { status, output, error })
}

tasks.create({
  id: 'dark-mode',
  title: 'Dark mode toggle in settings',
  repoRoot,
  plan: 'Add an Appearance setting (System, Light, Dark), saved in localStorage, that sets a class on the html element.',
  testing: 'npm run dev, then localhost:5173. Smoke test: npm run e2e -- settings.',
})
tasks.update('dark-mode', { notes: 'Reuse the existing CSS variables; no theme library.' })
worker(
  'codex-dark-mode',
  { title: 'Dark mode toggle', engine: 'codex', model: 'gpt-5.5', effort: 'high', taskId: 'dark-mode' },
  'Add an Appearance setting with System, Light and Dark under Settings.',
)
finish('codex-dark-mode', 'finished', 'Added an Appearance section to Settings. The choice is saved in localStorage. `npm test` passes.')
tasks.deliver('dark-mode', '4f2a9c1e', 'Refresh `localhost:5173/settings`, then set Appearance to Dark.')

tasks.create({
  id: 'pagination',
  title: 'Departures board pagination',
  repoRoot,
  plan: '20 rows a page; the page number lives in the URL (`?page=2`); keyboard navigation keeps working.',
  testing: 'npm test, then localhost:5173/departures?page=2.',
})
worker(
  'codex-pagination',
  { title: 'Pagination URL state', engine: 'codex', taskId: 'pagination' },
  'Keep the departures page number in the URL as ?page=N.',
)
finish('codex-pagination', 'failed', null, 'tsc: Type "string | null" is not assignable to type "number" (src/board/pager.ts:41)')
worker(
  'claude-pagination',
  { title: 'Departures board pagination', engine: 'claude', model: 'opus', effort: 'high', taskId: 'pagination' },
  'Add pagination to the departures board: 20 rows a page, the page in the URL, and keep keyboard navigation working.',
)

tasks.create({
  id: 'vite',
  title: 'Upgrade Vite to 8',
  repoRoot,
  plan: 'Upgrade Vite and its plugins; keep the dev server port.',
  testing: 'npm run build && npm test',
})
worker('codex-vite', { title: 'Upgrade Vite', engine: 'codex', taskId: 'vite' }, 'Upgrade Vite and its plugins.')
finish('codex-vite', 'finished', 'Upgraded Vite and both plugins. The build and tests pass.')
tasks.deliver('vite', 'b7d2e01f', 'Run `npm run dev`; the port is still 5173.')
tasks.setStatus('vite', 'done', ['waiting'])

worker(
  'agy-cold-start',
  { title: 'Profile cold start', engine: 'agy', model: 'gemini-3-flash', effort: 'low' },
  'Profile the app cold start and list the three slowest steps.',
)
finish('agy-cold-start', 'interrupted', null, 'Moxy restarted during this turn')

for (const [index, text] of [
  'The departures board needs pagination: 20 rows a page, and keep the page in the URL.',
  'Is the dark mode toggle ready?',
].entries()) {
  moxy.conversation.receive(userMessage(text, `seed-${index}`))
  moxy.loop.wake()
  await moxy.loop.idle()
}
leader.delayMs = REPLY_DELAY_MS

const proxy = createServer((incoming, outgoing) => {
  const upstream = request(
    {
      host: '127.0.0.1',
      port: moxy.webPort,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, 'tailscale-user-login': LOGIN },
    },
    response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(outgoing)
    },
  )
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502)
    outgoing.end('Preview server unavailable')
  })
  incoming.pipe(upstream)
})
await new Promise<void>((resolve, reject) => {
  proxy.once('error', reject)
  proxy.listen(PREVIEW_PORT, '127.0.0.1', resolve)
})
console.log(`Moxy preview on http://localhost:${PREVIEW_PORT} with fake data; no model runs. Say "fail" to see a failed turn.`)

let closing = false
async function close() {
  if (closing) return
  closing = true
  proxy.closeAllConnections()
  await new Promise<void>(resolve => proxy.close(() => resolve()))
  await moxy.stop()
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  process.exit(0)
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
