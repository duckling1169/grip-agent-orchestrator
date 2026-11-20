import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'

import { engineSpec } from '../contracts/engines.js'
import type { Engine } from '../contracts/engines.js'

export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const extension = extname(bin).toLowerCase()
  const extensions = process.platform === 'win32' && !extension ? ['.com', '.exe'] : ['']
  if (process.platform === 'win32' && extension && extension !== '.com' && extension !== '.exe') return false
  const folders = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  return folders.some(folder => extensions.some(suffix => executable(join(folder, bin + suffix))))
}

export function isEngineInstalled(engine: Engine): boolean {
  return onPath(engineSpec(engine).bin)
}

export function engineUnavailable(engine: Engine): string {
  const { name, bin } = engineSpec(engine)
  const required = process.platform === 'win32' ? `${bin}.exe or ${bin}.com (.cmd and .bat shims are unsupported)` : bin
  return `${name} is not installed for Moxy: put ${required} on PATH`
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}
