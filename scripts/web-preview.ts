/** Local visual preview only. This proxy supplies a fake identity and must never run in the daemon. */
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { ChatManager } from '../src/chats/manager.js'
import { ChatStore } from '../src/chats/store.js'
import { Worktrees } from '../src/git/worktrees.js'
import { Quota } from '../src/quota/quota.js'
import type { ToolId } from '../src/quota/usage.js'
import { RunManager } from '../src/runs/manager.js'
import type { Engine } from '../src/runs/store.js'
import { RunStore } from '../src/runs/store.js'
import { FakeClaw } from '../src/testing/fake-claw.js'
import { CLAUDE_MODELS } from '../src/models.js'
import { startWebHttp } from '../src/web/server.js'

const login = 'preview@local'
const tempRoot = await realpath(tmpdir())
const base = await realpath(await mkdtemp(join(tempRoot, 'grip-web-preview-')))
const folder = join(base, 'project')
await mkdir(folder)
const home = join(base, 'home')
const chatStore = await ChatStore.open(home)
const store = await RunStore.open(home)

// Seed real stores directly; the preview never invokes an agent or reads a user's state.
const chat = await chatStore.create({ kind: 'grip', title: 'Improve the release dashboard', folder, engine: 'claude', model: 'Sonnet' })
let turn = await chatStore.startTurn(chat.id, 'Make the release dashboard easier to scan and review the recent failures.', 'user')
await chatStore.endTurn(chat.id, turn, {
  output: 'I’ll split the work into three focused tasks. I’ll review the changes together before proposing a merge.',
  sessionId: 'preview-conversation',
})
async function worker(engine: Engine, title: string, status: 'running' | 'done' | 'failed', output = '') {
  const run = await store.create({ title, engine, folder, cwd: folder, repo: null, chatId: chat.id, brief: { kind: 'text', text: title } })
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
})
const usage = (provider: ToolId, usedPercent: number) => async () => ({
  provider,
  windows: [
    {
      name: '5h',
      usedPercent,
      resetsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
      stale: false,
      observedAt: new Date().toISOString(),
    },
  ],
})
const quota = await Quota.open({
  path: join(home, 'quota.json'),
  readers: { claude: usage('claude', 42), codex: usage('codex', 68), agy: usage('agy', 83) },
})
await quota.refresh(['claude', 'codex', 'agy'])
class PreviewClaw extends EventEmitter<{ status: [string] }> {
  readonly status = 'ready'
  readonly version = 'preview'
}
const web = await startWebHttp({
  manager,
  store,
  chats,
  chatStore,
  quota,
  worktrees,
  claw: new PreviewClaw(),
  allowedLogins: [login],
  port: 0,
  host: 'preview',
  // Fixed machines, so the preview never reads Tailscale or calls other machines.
  machines: async () => ({
    machines: [
      {
        name: 'preview',
        dnsName: 'preview.example.ts.net',
        ips: ['100.64.0.1'],
        os: 'windows',
        online: true,
        self: true,
        grip: 'yes',
        url: 'https://preview.example.ts.net/',
      },
      {
        name: 'linux-box',
        dnsName: 'linux-box.example.ts.net',
        ips: ['100.64.0.2'],
        os: 'linux',
        online: true,
        self: false,
        grip: 'yes',
        url: 'https://linux-box.example.ts.net/',
      },
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
    ],
  }),
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
  proxy.listen(18799, '127.0.0.1', resolve)
})
console.log('Grip local preview: http://127.0.0.1:18799 (fake data; no models)')

let closing = false
async function close() {
  if (closing) return
  closing = true
  proxy.closeAllConnections()
  await new Promise<void>(resolve => proxy.close(() => resolve()))
  await web.close()
  await chats.stopAll({ kill: false })
  await manager.stopAll({ kill: false })
  const rel = relative(tempRoot, base)
  if (rel.startsWith('grip-web-preview-') && !rel.includes(sep) && (await realpath(base)) === base)
    await rm(base, { recursive: true, force: true })
}
process.once('SIGINT', () => void close().then(() => process.exit(0)))
process.once('SIGTERM', () => void close().then(() => process.exit(0)))
