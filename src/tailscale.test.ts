import { describe, expect, it } from 'vitest'

import type { Exec } from './exec.js'
import { tailscaleOwner } from './tailscale.js'

const answer =
  (stdout: string, code = 0): Exec =>
  async () => ({ code, stdout, stderr: '' })
const status = (over: object = {}) =>
  JSON.stringify({ BackendState: 'Running', Self: { UserID: 81 }, User: { '81': { LoginName: 'duckling1169@github' } }, ...over })

describe('tailscaleOwner', () => {
  it('reads the signed-in account from tailscale status', async () => {
    expect(await tailscaleOwner(answer(status()))).toBe('duckling1169@github')
  })

  it('has no owner when Tailscale is stopped, missing, or the machine is tagged', async () => {
    expect(await tailscaleOwner(answer(status({ BackendState: 'Stopped' })))).toBeNull()
    expect(await tailscaleOwner(answer(status({ Self: { UserID: 81, Tags: ['tag:server'] } })))).toBeNull()
    expect(await tailscaleOwner(answer('', 1))).toBeNull()
    expect(
      await tailscaleOwner(async () => {
        throw new Error('spawn tailscale ENOENT')
      }),
    ).toBeNull()
  })
})
