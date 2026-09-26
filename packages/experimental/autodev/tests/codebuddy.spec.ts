import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { codeBuddyTaskPrompt, createCodeBuddyOutputObserver, parseCodeBuddyStreamOutput, resolveCodeBuddyEntry } from '../src/codebuddy.ts'
import type { CommandResult } from '../src/command.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('optional CodeBuddy CLI integration', () => {
  it('discovers only the direct JavaScript package entry under PATH roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codebuddy-fixture-'))
    roots.push(root)
    const packageRoot = join(root, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin')
    mkdirSync(packageRoot, { recursive: true })
    const entry = join(packageRoot, 'codebuddy')
    writeFileSync(entry, '#!/usr/bin/env node\n')
    expect(resolveCodeBuddyEntry(`${join(root, 'empty')}${delimiter}${root}`)).toBe(entry)
    expect(resolveCodeBuddyEntry(join(root, 'empty'))).toBeUndefined()
  })

  it('bounds the prompt to the isolated workspace and explicit acceptance checks', () => {
    const prompt = codeBuddyTaskPrompt({
      cwd: 'D:\\worktrees\\attempt-1',
      request: 'Add a compact settings panel',
      acceptanceCriteria: ['The app builds', 'The existing data remains intact'],
    })
    expect(prompt).toContain('D:\\worktrees\\attempt-1')
    expect(prompt).toContain('Add a compact settings panel')
    expect(prompt).toContain('- The app builds')
    expect(prompt).toContain('do not access or modify parent checkouts')
  })

  it('parses CodeBuddy stream-json and exposes partial text and tool activity as advisory progress', () => {
    const progress: unknown[] = []
    const observer = createCodeBuddyOutputObserver(event => progress.push(event))
    const partial = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"I found the failing branch."}}}\n'
    observer.onOutput('stdout', partial.slice(0, 41))
    observer.onOutput('stdout', partial.slice(41))
    observer.onOutput('stdout', '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Edit"}}}\n')

    const result: CommandResult = {
      argv: ['codebuddy'], cwd: process.cwd(), exitCode: 0, signal: null,
      stdout: `${partial}{"type":"result","subtype":"success","is_error":false,"result":"Added the regression test."}\n`,
      stderr: '', timedOut: false, durationMs: 1,
    }
    expect(observer.complete(result)).toEqual({ output: 'Added the regression test.', failed: false })
    expect(progress).toContainEqual({ type: 'assistant-delta', text: 'I found the failing branch.' })
    expect(progress).toContainEqual({ type: 'activity', activity: 'tool-started' })
  })

  it('fails closed when CodeBuddy reports an execution error or omits its terminal success result', () => {
    expect(parseCodeBuddyStreamOutput(
      '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["authentication failed"]}',
    )).toMatchObject({ failed: true, diagnostic: 'CodeBuddy error_during_execution: authentication failed' })
    expect(parseCodeBuddyStreamOutput(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Partial answer"}]}}',
    )).toMatchObject({ output: 'Partial answer', failed: true, diagnostic: 'CodeBuddy stream ended without a final success result' })
  })
})
