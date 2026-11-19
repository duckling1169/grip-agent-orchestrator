import { access } from 'node:fs/promises'
import { join } from 'node:path'

import semver from 'semver'

import { exec, execOk } from '../../exec.js'
import type { Exec } from '../../exec.js'

export const CLAW_PACKAGE = '@enderfga/claw-orchestrator'
export const CLAW_RANGE = '>=7.23.4 <8'

export async function installedClawCli(run: Exec = exec): Promise<string> {
  const globalRoot = (await execOk(run, 'npm', ['root', '-g'], 30_000)).trim()
  const cli = join(globalRoot, ...CLAW_PACKAGE.split('/'), 'dist', 'bin', 'cli.js')
  try {
    await access(cli)
  } catch {
    throw new Error(`Claw is not installed. Install it with: npm install -g "${CLAW_PACKAGE}@${CLAW_RANGE}"`)
  }
  return cli
}

export function assertSupportedClaw(version: string): void {
  if (!semver.valid(version) || !semver.satisfies(version, CLAW_RANGE)) {
    throw new Error(`Claw ${version} is not supported; Moxy needs ${CLAW_RANGE}`)
  }
}
