import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import semver from 'semver'

import { exec, execOk } from '../../exec.js'
import type { Exec } from '../../exec.js'

export const CLAW_PACKAGE = '@enderfga/claw-orchestrator'
export const CLAW_RANGE = '>=7.23.4 <8'

const CLAW_INSTALL_MS = 5 * 60_000

async function clawFolder(run: Exec): Promise<string> {
  const globalRoot = (await execOk(run, 'npm', ['root', '-g'], 30_000)).trim()
  return join(globalRoot, ...CLAW_PACKAGE.split('/'))
}

export async function installedClawCli(run: Exec = exec): Promise<string> {
  const cli = join(await clawFolder(run), 'dist', 'bin', 'cli.js')
  try {
    await access(cli)
  } catch {
    throw new Error(`Claw is not installed. Install it with: npm install -g "${CLAW_PACKAGE}@${CLAW_RANGE}"`)
  }
  return cli
}

export async function installedClawVersion(run: Exec = exec): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(await clawFolder(run), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

export async function installClaw(run: Exec = exec): Promise<string> {
  await execOk(run, 'npm', ['install', '-g', `${CLAW_PACKAGE}@${CLAW_RANGE}`, '--no-fund', '--no-audit'], CLAW_INSTALL_MS)
  const version = await installedClawVersion(run)
  if (!version) throw new Error(`npm installed ${CLAW_PACKAGE}, but Moxy cannot find it in npm's global folder`)
  assertSupportedClaw(version)
  return version
}

export function isSupportedClaw(version: string | null): version is string {
  return version !== null && semver.valid(version) !== null && semver.satisfies(version, CLAW_RANGE)
}

export function assertSupportedClaw(version: string): void {
  if (!isSupportedClaw(version)) throw new Error(`Claw ${version} is not supported; Moxy needs ${CLAW_RANGE}`)
}
