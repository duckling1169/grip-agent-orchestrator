import { describe, expect, it } from 'vitest'

import { PLAIN_COMMANDS_RULE } from '../contracts/engines.js'
import { leaderPrompt } from './leader-prompt.js'

describe('leader prompt', () => {
  it('names Moxy and its machine, and lists the known repositories', () => {
    const prompt = leaderPrompt({
      machine: 'Workstation',
      engine: 'claude',
      repoFolders: ['C:\\code'],
      repos: ['C:\\code\\app', 'C:\\code\\site'],
    })
    expect(prompt).toMatch(/^You are Moxy, the user's coding coordinator on the computer Workstation\./)
    expect(prompt).toContain('Known repositories:\n- C:\\code\\app\n- C:\\code\\site\n')
    expect(prompt).toContain('Do not explore the file system to answer a greeting')
    expect(prompt).toContain(`# Commands\n${PLAIN_COMMANDS_RULE}\n`)
  })

  it("steers delegation away from the leader's own engine and its quota", () => {
    const prompt = leaderPrompt({ machine: 'pc', engine: 'codex', repoFolders: [], repos: [] })
    expect(prompt).toContain("You run on Codex, so your own turns use Codex's quota. Prefer workers on other engines")
    expect(prompt).toContain("Choose each worker's model and effort on purpose")
    expect(prompt).toContain('Your own model and effort set no limit either way.')
  })

  it('asks for a path when no repository folders are configured', () => {
    const prompt = leaderPrompt({ machine: 'pc', engine: 'claude', repoFolders: [], repos: [] })
    expect(prompt).toContain('No repository folders are configured')
    expect(prompt).not.toContain('Known repositories')
  })
})
