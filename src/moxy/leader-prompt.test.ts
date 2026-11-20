import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PLAIN_COMMANDS_RULE } from '../contracts/engines.js'
import { leaderPrompt, skillSection } from './leader-prompt.js'

describe('leader prompt', () => {
  it('lists packaged skills with descriptions and absolute paths', () => {
    const prompt = leaderPrompt({ machine: 'pc', engine: 'claude', repoFolders: [], repos: [] })
    expect(prompt).toContain('# Skills\n')
    expect(prompt).toContain('creative-ideation:')
    expect(prompt).toContain('orchestrate-brainstorm:')
    expect(prompt).toContain('frontend-design: Guidance for distinctive, intentional visual design')
    expect(prompt).toContain('impeccable: Use when the user wants to design')
    expect(prompt).toContain(resolve('skills', 'frontend-design', 'SKILL.md'))
    expect(prompt).toContain('Read the full skill')
  })

  it('skips missing and malformed skill files without interrupting the leader', () => {
    const root = mkdtempSync(join(tmpdir(), 'moxy-skills-'))
    try {
      expect(skillSection(join(root, 'missing'))).toContain('No packaged skills are available')
      mkdirSync(join(root, 'creative-ideation'))
      writeFileSync(join(root, 'creative-ideation', 'SKILL.md'), '---\nname: wrong\ndescription: Invalid\n---\n')
      mkdirSync(join(root, 'frontend-design'))
      writeFileSync(join(root, 'frontend-design', 'SKILL.md'), '---\nname: frontend-design\ndescription: Useful design guidance\n---\n')
      mkdirSync(join(root, 'impeccable'))
      writeFileSync(join(root, 'impeccable', 'SKILL.md'), '---\nname: impeccable\ndescription: "unfinished\n---\n')
      const section = skillSection(root)
      expect(section).toContain(`frontend-design: Useful design guidance — ${join(root, 'frontend-design', 'SKILL.md')}`)
      expect(section).not.toContain('creative-ideation:')
      expect(section).not.toContain('impeccable:')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
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

  it('guides the leader on project notes and conversation recall', () => {
    const prompt = leaderPrompt({ machine: 'pc', engine: 'claude', repoFolders: [], repos: [] })
    expect(prompt).toContain('notes_read')
    expect(prompt).toContain('notes_update')
    expect(prompt).toContain('history_search')
    expect(prompt).toContain('history_read')
    expect(prompt).not.toContain('only memory across sessions')
  })
})
