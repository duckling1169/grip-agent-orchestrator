// Stands in for `clawo serve --port <p> --host 127.0.0.1` in process tests: answers /health,
// and exits on POST /crash so tests can watch Grip restart it.
import { createServer } from 'node:http'

const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, version: process.env.FAKE_CLAW_VERSION ?? '7.23.4', sessions: 0, token: !!process.env.OPENCLAW_SERVER_TOKEN }))
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
