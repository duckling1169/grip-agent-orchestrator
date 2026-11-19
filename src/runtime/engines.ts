import { existsSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'

import { engineSpec } from '../contracts/engines.js'
import type { Engine } from '../contracts/engines.js'

export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const extensions =
    process.platform === 'win32' && !extname(bin) ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : ['']
  const folders = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  return folders.some(folder => extensions.some(extension => existsSync(join(folder, bin + extension))))
}

export function isEngineInstalled(engine: Engine): boolean {
  return onPath(engineSpec(engine).bin)
}
