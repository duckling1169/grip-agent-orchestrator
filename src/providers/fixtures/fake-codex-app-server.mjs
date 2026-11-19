import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.argv.includes('--fail') ? 'fail' : process.argv.includes('--exit') ? 'exit' : 'ok'
const limits = JSON.parse(readFileSync(new URL('./codex-rate-limits.json', import.meta.url), 'utf8'))
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
let initialized = false

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (mode === 'exit') process.exit(3)
    send({ id: message.id, result: { userAgent: 'fake', codexHome: '', platformFamily: 'test', platformOs: 'test' } })
    send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } })
  } else if (message.method === 'initialized') {
    initialized = true
  } else if (message.method === 'account/rateLimits/read') {
    if (!initialized) send({ id: message.id, error: { code: -32600, message: 'not initialized' } })
    else if (mode === 'fail') send({ id: message.id, error: { code: -32603, message: 'not signed in' } })
    else send({ id: message.id, result: limits })
  }
})
