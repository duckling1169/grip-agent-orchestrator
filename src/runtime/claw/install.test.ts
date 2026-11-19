import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Exec } from '../../exec.js'
import { temporaryHome } from '../../testing/harness.js'
import { assertSupportedClaw, installedClawCli } from './install.js'

const npmRootAt =
  (root: string): Exec =>
  async () => ({ code: 0, stdout: `${root}\n`, stderr: '' })

describe('installedClawCli', () => {
  it('finds the Claw CLI in the global npm root', async () => {
    const root = await temporaryHome()
    const bin = join(root, '@enderfga', 'claw-orchestrator', 'dist', 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'cli.js'), '')
    expect(await installedClawCli(npmRootAt(root))).toBe(join(bin, 'cli.js'))
  })

  it('explains how to install Claw when it is missing', async () => {
    await expect(installedClawCli(npmRootAt(await temporaryHome()))).rejects.toThrow(
      'npm install -g "@enderfga/claw-orchestrator@>=7.23.4 <8"',
    )
  })
})

describe('assertSupportedClaw', () => {
  it('accepts every 7.x from 7.23.4', () => {
    expect(() => assertSupportedClaw('7.23.4')).not.toThrow()
    expect(() => assertSupportedClaw('7.40.0')).not.toThrow()
  })

  it('refuses older, newer major and invalid versions', () => {
    for (const version of ['7.23.3', '8.0.0', 'latest']) expect(() => assertSupportedClaw(version)).toThrow('not supported')
  })
})
