import { mkdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

import { expect, it } from 'vitest'

import { temporaryHome } from '../testing/harness.js'
import { onPath } from './engines.js'

it.skipIf(process.platform !== 'win32')('only lists Windows executables that can be spawned without a shell', async () => {
  const home = await temporaryHome()
  const other = join(home, 'other')
  await mkdir(other)
  await writeFile(join(home, 'tool.cmd'), '@echo off')
  await writeFile(join(home, 'tool.bat'), '@echo off')
  await writeFile(join(home, 'tool'), '#!/bin/sh')
  await mkdir(join(home, 'tool.exe'))
  const env = { Path: [home, other].join(delimiter), PATHEXT: '.CMD;.BAT' }
  expect(onPath('tool', env)).toBe(false)
  await writeFile(join(other, 'tool.exe'), '')
  expect(onPath('tool', env)).toBe(true)
})
