import { describe, expect, it } from 'vitest'

import { leaderPrompt } from './leader-prompt.js'

describe('leader prompt', () => {
  it('names Moxy and its machine, and lists the known repositories', () => {
    const prompt = leaderPrompt({ machine: 'Workstation', repoFolders: ['C:\\code'], repos: ['C:\\code\\app', 'C:\\code\\site'] })
    expect(prompt).toMatch(/^You are Moxy, the user's coding coordinator on the computer Workstation\./)
    expect(prompt).toContain('Known repositories:\n- C:\\code\\app\n- C:\\code\\site\n')
    expect(prompt).toContain('Do not explore the file system to answer a greeting')
  })

  it('asks for a path when no repository folders are configured', () => {
    const prompt = leaderPrompt({ machine: 'pc', repoFolders: [], repos: [] })
    expect(prompt).toContain('No repository folders are configured')
    expect(prompt).not.toContain('Known repositories')
  })
})
