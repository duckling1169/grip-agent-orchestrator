import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { engineSpec } from '../contracts/engines.js'
import type { Engine } from '../contracts/engines.js'

const WINDOWS_EXECUTABLES = ['.com', '.exe']
const WINDOWS_ENGINE_COMMANDS = [...WINDOWS_EXECUTABLES, '.bat', '.cmd']

export function isEngineInstalled(engine: Engine): boolean {
  return onPath(engineSpec(engine).bin, WINDOWS_ENGINE_COMMANDS)
}

export function canSpawnDirectly(engine: Engine): boolean {
  return onPath(engineSpec(engine).bin, WINDOWS_EXECUTABLES)
}

export function requireDirectBinary(engine: Engine): string {
  const { bin, name } = engineSpec(engine)
  if (canSpawnDirectly(engine)) return bin
  if (process.platform !== 'win32') throw new Error(engineUnavailable(engine))
  throw new Error(
    `${name} cannot launch directly: put ${bin}.exe or ${bin}.com on PATH (.cmd and .bat shims are unsupported for direct launches)`,
  )
}

export function engineUnavailable(engine: Engine): string {
  const { name, bin } = engineSpec(engine)
  return `${name} is not installed on this machine (no ${bin} on PATH)`
}

function onPath(bin: string, windowsExtensions: string[]): boolean {
  const extensions = process.platform === 'win32' ? windowsExtensions : ['']
  const folders = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
  return folders.some(folder => extensions.some(suffix => executable(join(folder, bin + suffix))))
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}
