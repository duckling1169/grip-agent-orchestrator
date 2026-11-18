// End-to-end check against a running `grip serve`: delegate one tiny task per engine, collect the
// results with wait_any, then send a follow-up to test resume. Spends a few cheap turns.
//   npx tsx scripts/mcp-e2e.ts <repo-folder> [engines=claude,codex,agy]
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { DEFAULT_MCP_PORT } from '../src/mcp/http.js'
import { gripPaths } from '../src/paths.js'

const [folder, engineList = 'claude,codex,agy'] = process.argv.slice(2)
if (!folder) throw new Error('usage: mcp-e2e.ts <repo-folder> [engines]')
const engines = engineList.split(',')

const token = (await readFile(join(gripPaths().home, 'mcp-token'), 'utf8')).trim()
const client = new Client({ name: 'grip-e2e', version: '1' })
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
)
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60 * 1000 })
  const text = (result.content as { text: string }[])[0]!.text
  if (result.isError) throw new Error(`${name}: ${text}`)
  return JSON.parse(text)
}
const say = (event: string, data: unknown) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...(data as object) }))

const ids: Record<string, string> = {}
for (const engine of engines) {
  const run = await call('delegate', {
    folder,
    engine,
    brief_text: `Create a file named hello-${engine}.txt containing the single word OK. Then reply with DONE and nothing else.`,
  })
  ids[run.id] = engine
  say('delegated', { engine, id: run.id, branch: run.branch, worktree: run.worktree })
}

const report = (r: {
  id: string
  status: string
  error: string | null
  turns: { output: string }[]
  git: { changedFiles: string[] } | null
}) =>
  say('result', {
    engine: ids[r.id],
    id: r.id,
    status: r.status,
    error: r.error,
    output: r.turns.at(-1)?.output?.slice(0, 200),
    changed: r.git?.changedFiles,
  })

for (let i = 0; i < engines.length; i++) {
  const r = await call('wait_any', { timeout_sec: 600, run_ids: Object.keys(ids) })
  if (!r) throw new Error('wait_any timed out')
  report(r)
}

const followId = Object.keys(ids).find(id => ids[id] === 'codex') ?? Object.keys(ids)[0]!
await call('message', {
  run_id: followId,
  text: 'Append a second line with the word AGAIN to the same file. Then reply with DONE and nothing else.',
})
const followed = await call('wait_any', { timeout_sec: 600, run_ids: [followId] })
report(followed)
say('turns', { id: followId, outputs: followed.turns.map((t: { output: string }) => t.output?.slice(0, 80)) })
say('list', {
  runs: (await call('list', {})).map(
    (r: { id: string; engine: string; status: string; turns: number }) => `${r.engine}:${r.status}:${r.turns}`,
  ),
})
await client.close()
