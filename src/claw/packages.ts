import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import semver from 'semver'

import { exec as defaultExec, execOk } from '../exec.js'
import type { Exec } from '../exec.js'
import { CLAW_PACKAGE } from './versions.js'

/** Where Claw comes from and where it is installed. The supervisor only talks to this. */
export interface ClawPackages {
  /** The globally installed version, or null when Claw is not installed. */
  installed(): Promise<string | null>
  /** Every version published to npm. Throws when npm cannot be reached. */
  available(): Promise<string[]>
  install(version: string): Promise<void>
  /** Absolute path of the installed `clawo` entry script, run with Node directly. */
  cliPath(): Promise<string>
}

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

/** Claw installed globally with npm, the way its README says to. */
export class NpmClawPackages implements ClawPackages {
  private root: string | null = null

  constructor(private readonly run: Exec = defaultExec) {}

  private async globalRoot(): Promise<string> {
    this.root ??= (await execOk(this.run, 'npm', ['root', '-g'], 30_000)).trim()
    return this.root
  }

  private async packageDir(): Promise<string> {
    return join(await this.globalRoot(), ...CLAW_PACKAGE.split('/'))
  }

  async installed(): Promise<string | null> {
    try {
      const pkg = JSON.parse(await readFile(join(await this.packageDir(), 'package.json'), 'utf8')) as { version?: unknown }
      return typeof pkg.version === 'string' && semver.valid(pkg.version) ? pkg.version : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async available(): Promise<string[]> {
    const out = await execOk(this.run, 'npm', ['view', CLAW_PACKAGE, 'versions', '--json'], 60_000)
    const parsed = JSON.parse(out) as unknown
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.filter((v): v is string => typeof v === 'string')
  }

  async install(version: string): Promise<void> {
    if (!semver.valid(version)) throw new Error(`refusing to install invalid version "${version}"`)
    await execOk(this.run, 'npm', ['install', '-g', `${CLAW_PACKAGE}@${version}`, '--no-fund', '--no-audit'], INSTALL_TIMEOUT_MS)
    const now = await this.installed()
    if (now !== version) throw new Error(`npm reported success but ${CLAW_PACKAGE} is at ${now ?? 'nothing'}, not ${version}`)
  }

  async cliPath(): Promise<string> {
    return join(await this.packageDir(), 'dist', 'bin', 'cli.js')
  }
}
