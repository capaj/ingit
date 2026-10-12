import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoSession, runGit } from '@ingit/git-core'
import { generateCommitMessage, getInstalledCommitMessageAgents } from '../src/commit-message.js'

let rootPath: string
let repo: RepoSession

beforeEach(async () => {
  rootPath = await mkdtemp(join(tmpdir(), 'ingit-commit-message-'))
  await runGit(['init', '--initial-branch=main'], rootPath)
  await runGit(['config', 'user.name', 'Test'], rootPath)
  await runGit(['config', 'user.email', 'test@example.com'], rootPath)
  await writeFile(join(rootPath, 'tracked.txt'), 'original\n')
  await runGit(['add', '.'], rootPath)
  await runGit(['commit', '-m', 'feat: initial example'], rootPath)
  repo = await RepoSession.open(rootPath)
})

afterEach(async () => {
  repo?.close()
  await rm(rootPath, { recursive: true, force: true })
})

describe('commit message generation', () => {
  test.skipIf(process.platform === 'win32')('detects installed CLIs on PATH without starting sessions', async () => {
    const which = (name: string) => Bun.which(name, { PATH: rootPath })
    expect(getInstalledCommitMessageAgents(which)).toEqual([])
    for (const agent of ['claude', 'codex']) {
      const executable = join(rootPath, agent)
      // Not executable program contents: detection must only locate the file.
      await writeFile(executable, 'This CLI has never been run')
      await chmod(executable, 0o755)
      expect(getInstalledCommitMessageAgents(which)).toEqual(agent === 'claude' ? ['claude'] : ['claude', 'codex'])
    }
    await rm(join(rootPath, 'claude'))
    expect(getInstalledCommitMessageAgents(which)).toEqual(['codex'])
  })

  test('gives Claude read-only inspection tools without supplying patches or repository content', async () => {
    await writeFile(join(rootPath, 'tracked.txt'), 'staged content\n')
    await runGit(['add', 'tracked.txt'], rootPath)
    await writeFile(join(rootPath, 'tracked.txt'), 'unstaged secret content\n')
    await writeFile(join(rootPath, 'untracked.txt'), 'untracked secret content\n')
    const before = await repo.getWorktreeChanges()
    const result = await generateCommitMessage(repo, 'claude', {
      which: (name) => name === 'claude' ? '/bin/claude' : null,
      run: async (command, cwd, prompt) => {
        expect(command).toContain('--print')
        expect(command[command.indexOf('--model') + 1]).toBe('haiku')
        expect(command).toContain('--tools')
        expect(command[command.indexOf('--tools') + 1]).toBe('Bash,Read,Glob,Grep')
        expect(command).toContain('dontAsk')
        expect(cwd).toBe(rootPath)
        expect(prompt).toContain('git diff --cached')
        expect(prompt).toContain('partially staged files')
        expect(prompt).toContain('untracked files')
        expect(prompt).not.toContain('staged content')
        expect(prompt).not.toContain('feat: initial example')
        expect(prompt).not.toContain('unstaged secret content')
        expect(prompt).not.toContain('untracked.txt')
        return { code: 0, stdout: JSON.stringify({ result: 'fix: update tracked content\n', is_error: false }), stderr: '' }
      },
    })
    expect(result).toEqual({ message: 'fix: update tracked content', agent: 'claude' })
    expect(await repo.getWorktreeChanges()).toEqual(before)
  })

  test('uses the selected Codex provider even when Claude is also installed', async () => {
    await rm(join(rootPath, 'tracked.txt'))
    await writeFile(join(rootPath, 'new file.txt'), 'new untracked content\n')
    const before = await repo.getWorktreeChanges()
    const lookups: string[] = []
    const result = await generateCommitMessage(repo, 'codex', {
      which: (name) => { lookups.push(name); return `/bin/${name}` },
      run: async (command, _cwd, prompt) => {
        expect(command.slice(0, 4)).toEqual(['/bin/codex', 'exec', '--sandbox', 'read-only'])
        expect(command[command.indexOf('--model') + 1]).toBe('gpt-6-luna')
        expect(command).toContain('model_reasoning_effort="low"')
        expect(command.at(-1)).toBe('-')
        expect(prompt).toContain('If nothing is staged')
        expect(prompt).toContain('read the untracked files')
        expect(prompt).not.toContain('-original')
        expect(prompt).not.toContain('new untracked content')
        expect(prompt).not.toContain('tracked.txt')
        return { code: 0, stdout: 'Replace the example file\n', stderr: 'progress output' }
      },
    })
    expect(result).toEqual({ message: 'Replace the example file', agent: 'codex' })
    expect(lookups).toEqual(['codex'])
    expect(await repo.getWorktreeChanges()).toEqual(before)
  })

  test('asks the agent to inspect unstaged changes rather than providing their contents', async () => {
    await writeFile(join(rootPath, 'tracked.txt'), 'edited content\n')
    await generateCommitMessage(repo, 'claude', {
      which: () => 'claude',
      run: async (_command, _cwd, prompt) => {
        expect(prompt).toContain('git status')
        expect(prompt).toContain('git diff --no-ext-diff --no-textconv')
        expect(prompt).not.toContain('edited content')
        return { code: 0, stdout: '{"result":"Update the example"}', stderr: '' }
      },
    })
  })

  test('works before the first commit', async () => {
    await runGit(['checkout', '--orphan', 'unborn'], rootPath)
    await runGit(['rm', '--cached', '-r', '.'], rootPath)
    await generateCommitMessage(repo, 'claude', {
      which: () => 'claude',
      run: async (_command, _cwd, prompt) => {
        expect(prompt).toContain('repositories with no commits yet')
        expect(prompt).not.toContain('+original')
        return { code: 0, stdout: '{"result":"Add the example"}', stderr: '' }
      },
    })
  })

  test('rejects clean repositories and missing CLIs with actionable errors', async () => {
    await expect(generateCommitMessage(repo, 'claude')).rejects.toThrow('There are no changes')
    await writeFile(join(rootPath, 'tracked.txt'), 'changed\n')
    const lookups: string[] = []
    await expect(generateCommitMessage(repo, 'codex', { which: (name) => { lookups.push(name); return null } })).rejects.toThrow('Install and sign in to Codex CLI')
    expect(lookups).toEqual(['codex'])
  })

  test('requires a saved provider and never guesses one', async () => {
    await expect(generateCommitMessage(repo, null, {
      which: () => { throw new Error('Must not look up a CLI before the user chooses') },
    })).rejects.toThrow('Choose Claude Code or Codex')
  })

  test('surfaces CLI failures and rejects empty or invalid output', async () => {
    await writeFile(join(rootPath, 'tracked.txt'), 'changed\n')
    for (const [result, error] of [
      [{ code: 1, stdout: '', stderr: 'Please log in' }, 'Please log in'],
      [{ code: 0, stdout: '{"is_error":true,"result":"Authentication expired"}', stderr: '' }, 'Authentication expired'],
      [{ code: 0, stdout: '{"result":"  "}', stderr: '' }, 'empty commit message'],
      [{ code: 0, stdout: 'unexpected output', stderr: '' }, 'invalid response'],
      [{ code: 0, stdout: 'null', stderr: '' }, 'invalid response'],
    ] as const) {
      await expect(generateCommitMessage(repo, 'claude', {
        which: () => 'claude', run: async () => result,
      })).rejects.toThrow(error)
    }
    await expect(generateCommitMessage(repo, 'codex', {
      which: (name) => name === 'codex' ? 'codex' : null,
      run: async () => ({ code: 0, stdout: '  ', stderr: '' }),
    })).rejects.toThrow('empty commit message')
  })

  test.skipIf(process.platform === 'win32')('runs the CLI in the repo so it can retrieve the patch itself', async () => {
    await writeFile(join(rootPath, 'tracked.txt'), 'staged content\n')
    await runGit(['add', 'tracked.txt'], rootPath)
    await writeFile(join(rootPath, 'tracked.txt'), 'unstaged content\n')
    const before = await repo.getWorktreeChanges()
    const executable = join(rootPath, 'fake-claude')
    await writeFile(executable, `#!/usr/bin/env bun
const prompt = await Bun.stdin.text()
if (prompt.includes('staged content') || !prompt.includes('git diff --cached')) process.exit(1)
const proc = Bun.spawn(['git', 'diff', '--cached', '--no-ext-diff', '--no-textconv'], { stdout: 'pipe' })
const patch = await new Response(proc.stdout).text()
if (await proc.exited || !patch.includes('+staged content') || patch.includes('unstaged content')) process.exit(1)
console.log(JSON.stringify({ result: 'Update the staged example' }))
`)
    await chmod(executable, 0o755)
    expect(await generateCommitMessage(repo, 'claude', { which: () => executable })).toEqual({
      message: 'Update the staged example', agent: 'claude',
    })
    // The fake CLI is itself untracked, so compare only the tracked file state.
    const after = await repo.getWorktreeChanges()
    expect(after.headSha).toBe(before.headSha)
    expect(after.staged).toEqual(before.staged)
    expect(after.unstaged.filter((file) => file.path !== 'fake-claude')).toEqual(before.unstaged)
  })
})
