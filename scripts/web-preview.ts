/** Local visual preview only. This proxy supplies a fake identity and must never run in the daemon. */
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { ChatManager } from '../src/chats/manager.js'
import { ChatStore } from '../src/chats/store.js'
import { Worktrees } from '../src/git/worktrees.js'
import { PushNotifier } from '../src/push/notifier.js'
import { Quota } from '../src/quota/quota.js'
import type { ToolId } from '../src/quota/usage.js'
import { RunManager } from '../src/runs/manager.js'
import type { Engine } from '../src/runs/store.js'
import { RunStore } from '../src/runs/store.js'
import { FakeClaw } from '../src/testing/fake-claw.js'
import { acpLeaders } from '../src/chats/leaders.js'
import { ENGINE_NAMES } from '../src/engines.js'
import { CLAUDE_MODELS } from '../src/models.js'
import { fakeAcpAgent } from '../src/testing/fake-acp-agent.js'
import type { Machine } from '../src/web/machines.js'
import { startWebHttp } from '../src/web/server.js'

const login = 'preview@local'
const tempRoot = await realpath(tmpdir())
const base = await realpath(await mkdtemp(join(tempRoot, 'grip-web-preview-')))

// Two fake machines, so switching machines can be tried locally. The app is opened from the first.
const PORTS = { preview: 18799, 'linux-box': 18800 } as const
type Name = keyof typeof PORTS
const ORIGINS = new Set(Object.values(PORTS).flatMap(port => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]))
const machine = (name: Name, ip: string, self: boolean): Machine => ({
  name,
  dnsName: `${name}.example.ts.net`,
  ips: [ip],
  os: name === 'preview' ? 'windows' : 'linux',
  online: true,
  self,
  grip: 'yes',
  url: `http://localhost:${PORTS[name]}/`,
})
const machines = (self: Name): Machine[] => [
  machine('preview', '100.64.0.1', self === 'preview'),
  machine('linux-box', '100.64.0.2', self === 'linux-box'),
  {
    name: 'macbook-air',
    dnsName: 'macbook-air.example.ts.net',
    ips: ['100.64.0.3'],
    os: 'macOS',
    online: false,
    self: false,
    grip: 'unknown',
    url: null,
  },
]

class PreviewClaw extends EventEmitter<{ status: [string] }> {
  readonly status = 'ready'
  readonly version = 'preview'
}

async function startPreview(name: Name, seed: (s: Seed) => Promise<void>, used: Record<ToolId, number>) {
  const folder = join(base, name, 'project')
  await mkdir(folder, { recursive: true })
  const home = join(base, name, 'home')
  const chatStore = await ChatStore.open(home)
  const store = await RunStore.open(home)
  // Seed real stores directly; the preview never invokes an agent or reads a user's state.
  await seed({ chatStore, store, folder })

  const claw = new FakeClaw()
  const worktrees = new Worktrees()
  const manager = new RunManager({ store, worktrees, claw })
  const chats = new ChatManager({
    chats: chatStore,
    runs: manager,
    runStore: store,
    claw,
    secret: 'preview-only',
    mcpUrl: () => 'http://127.0.0.1:18797/mcp',
    // Codex and agy lead through an in-process fake ACP agent, so no agent starts.
    leaders: acpLeaders({ spawn: fakeAcpAgent({ http: true, loadSession: true, reply: 'A preview reply over ACP.' }).spawn }),
  })
  const usage = (provider: ToolId) => async () => ({
    provider,
    windows: [
      {
        name: '5h',
        usedPercent: used[provider],
        resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
        stale: false,
        observedAt: new Date().toISOString(),
      },
    ],
  })
  const quota = await Quota.open({
    path: join(home, 'quota.json'),
    readers: { claude: usage('claude'), codex: usage('codex'), agy: usage('agy') },
  })
  await quota.refresh(['claude', 'codex', 'agy'])
  // Notifications are recorded, never sent: the preview reaches no push service.
  const push = await PushNotifier.open({
    path: join(home, 'push.json'),
    allowedLogins: [login],
    sender: async (_subscription, payload) => (console.log(`[preview] push ${payload}`), { ok: true }),
  })
  push.watchRuns(store)
  const web = await startWebHttp({
    push,
    manager,
    store,
    chats,
    chatStore,
    quota,
    worktrees,
    claw: new PreviewClaw(),
    allowedLogins: [login],
    port: 0,
    host: name,
    // Fixed machines and trust, so the preview never reads Tailscale or calls other machines.
    machines: async () => ({ machines: machines(name) }),
    trustedOrigin: origin => ORIGINS.has(origin),
    // Fixed lists, so the preview never runs the Codex or agy CLIs.
    models: {
      list: async () => [
        { engine: 'claude', models: CLAUDE_MODELS, error: null },
        {
          engine: 'codex',
          models: [{ id: 'gpt-preview', label: 'GPT Preview', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', isDefault: true }],
          error: null,
        },
        {
          engine: 'agy',
          models: [{ id: 'gemini-preview-high', label: 'Gemini Preview (High)', efforts: [], defaultEffort: null, isDefault: false }],
          error: null,
        },
      ],
    },
    // As if Kimi were installed too, so its worker and leader show.
    engines: {
      list: () => (['claude', 'codex', 'agy', 'kimi'] as const).map(engine => ({ engine, name: ENGINE_NAMES[engine], installed: true })),
    },
    leaders: {
      list: async () => [
        { engine: 'claude', available: true },
        { engine: 'codex', available: true },
        { engine: 'agy', available: false, reason: 'agy is not installed' },
        { engine: 'kimi', available: true },
      ],
    },
  })
  const proxy = createServer((incoming, outgoing) => {
    const upstream = request(
      {
        host: '127.0.0.1',
        port: web.port,
        path: incoming.url,
        method: incoming.method,
        headers: { ...incoming.headers, 'tailscale-user-login': login },
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
    proxy.listen(PORTS[name], '127.0.0.1', resolve)
  })
  return async () => {
    proxy.closeAllConnections()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    await web.close()
    await chats.stopAll({ kill: false })
    await manager.stopAll({ kill: false })
  }
}

type Seed = { chatStore: ChatStore; store: RunStore; folder: string }

async function seedPreview({ chatStore, store, folder }: Seed) {
  const chat = await chatStore.create({ kind: 'grip', title: 'Improve the release dashboard', folder, engine: 'claude', model: 'Sonnet' })
  let turn = await chatStore.startTurn(chat.id, 'Make the release dashboard easier to scan and review the recent failures.', 'user')
  await chatStore.endTurn(chat.id, turn, {
    output: 'I’ll split the work into three focused tasks. I’ll review the changes together before proposing a merge.',
    sessionId: 'preview-conversation',
  })
  async function worker(engine: Engine, title: string, status: 'running' | 'done' | 'failed', output = '') {
    const run = await store.create({
      title,
      engine,
      folder,
      cwd: folder,
      repo: null,
      chatId: chat.id,
      brief: { kind: 'text', text: title },
    })
    const n = await store.startTurn(run.id, title)
    if (status !== 'running')
      await store.endTurn(run.id, n, { output, ...(status === 'failed' ? { error: 'The preview test run failed.' } : {}) })
  }
  await worker(
    'codex',
    'Refine the release summary layout',
    'done',
    'Updated the summary hierarchy and added compact status labels.\n\n- Checks pass\n- Ready for review',
  )
  await worker('agy', 'Check the mobile navigation', 'failed', 'The narrow layout needs another pass before it is ready.')
  await worker('claude', 'Review the deployment timeline', 'running')
  turn = await chatStore.startTurn(chat.id, 'What should I look at first?', 'user')
  await chatStore.endTurn(chat.id, turn, {
    output:
      'The summary is ready to review. The mobile navigation needs attention; I’ll keep the timeline review moving.\n\n**Next:** inspect the failed mobile check.',
  })
}

async function seedLinuxBox({ chatStore, store, folder }: Seed) {
  const chat = await chatStore.create({ kind: 'grip', title: 'Tidy the server logs', folder, engine: 'claude' })
  const turn = await chatStore.startTurn(chat.id, 'Rotate the old server logs and summarize the errors.', 'user')
  await chatStore.endTurn(chat.id, turn, { output: 'Rotated the logs. Three errors repeat; details are in the worker.' })
  const run = await store.create({
    title: 'Summarize repeated errors',
    engine: 'codex',
    folder,
    cwd: folder,
    repo: null,
    chatId: chat.id,
    brief: { kind: 'text', text: 'Summarize repeated errors' },
  })
  const n = await store.startTurn(run.id, 'Summarize repeated errors')
  await store.endTurn(run.id, n, { output: 'Three errors repeat: disk full, DNS timeout, and a failed cron job.' })
}

const closers = [
  await startPreview('preview', seedPreview, { claude: 42, codex: 68, agy: 83 }),
  await startPreview('linux-box', seedLinuxBox, { claude: 10, codex: 20, agy: 30 }),
]
console.log(`Grip local preview: http://localhost:${PORTS.preview} (fake data; no models). Second machine on ${PORTS['linux-box']}.`)

let closing = false
async function close() {
  if (closing) return
  closing = true
  for (const closeOne of closers) await closeOne()
  const rel = relative(tempRoot, base)
  if (rel.startsWith('grip-web-preview-') && !rel.includes(sep) && (await realpath(base)) === base)
    await rm(base, { recursive: true, force: true })
}
process.once('SIGINT', () => void close().then(() => process.exit(0)))
process.once('SIGTERM', () => void close().then(() => process.exit(0)))
