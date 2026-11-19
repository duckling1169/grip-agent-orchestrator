import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import { Database } from '../db/database.js'
import { MOXY_SCHEMA } from '../db/schema.js'
import { temporaryHome } from '../testing/harness.js'
import { Memory } from './memory.js'

describe('Memory', () => {
  it('keeps standing instructions and preferences across restart and preserves untouched fields', async () => {
    const path = join(await temporaryHome(), 'moxy.db')
    let database = Database.open(path, MOXY_SCHEMA)
    onTestFinished(() => database.close())
    const memory = new Memory(database)
    expect(memory.read()).toMatchObject({ instructions: '', preferences: '' })
    memory.update({ instructions: 'Ask before pushing', preferences: 'Keep replies short' })
    memory.update({ preferences: 'Prefer focused tests' })
    database.close()
    database = Database.open(path, MOXY_SCHEMA)
    expect(new Memory(database).read()).toMatchObject({ instructions: 'Ask before pushing', preferences: 'Prefer focused tests' })
  })

  it('bounds each field before writing and supports clearing saved memory', async () => {
    const database = Database.open(join(await temporaryHome(), 'moxy.db'), MOXY_SCHEMA)
    onTestFinished(() => database.close())
    const memory = new Memory(database)
    memory.update({ instructions: 'Original' })
    expect(() => memory.update({ instructions: 'x'.repeat(8001), preferences: 'Not saved' })).toThrow('instructions')
    expect(() => memory.update({ preferences: 'x'.repeat(16001) })).toThrow('preferences')
    expect(memory.read()).toMatchObject({ instructions: 'Original', preferences: '' })
    expect(memory.update({ instructions: '', preferences: '' })).toMatchObject({ instructions: '', preferences: '' })
  })
})
