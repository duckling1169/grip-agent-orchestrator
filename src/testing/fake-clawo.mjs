import { createServer } from 'node:http'

const port = Number(process.argv[process.argv.indexOf('--port') + 1])

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        version: process.env.FAKE_CLAW_VERSION ?? '7.23.4',
        sessions: 0,
        token: !!process.env.OPENCLAW_SERVER_TOKEN,
      }),
    )
    return
  }
  if (req.url === '/session/list') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, sessions: [] }))
    return
  }
  if (req.url === '/session/grep') {
    const step = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- pager', description: 'Run the pager tests' } }],
      },
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({ ok: true, count: 1, matches: [{ time: new Date().toISOString(), type: 'output', content: JSON.stringify(step) }] }),
    )
    return
  }
  if (req.url === '/crash') {
    res.end()
    process.exit(3)
  }
  res.writeHead(404)
  res.end()
})

server.listen(port, '127.0.0.1', () => console.log(`fake clawo on ${port}`))
