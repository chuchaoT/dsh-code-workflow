import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const baseURL = process.env.DSH_OLLAMA_BASE_URL
const model = process.env.DSH_OLLAMA_MODEL ?? 'qwen3:8b-fast'
const credentialRef = 'DSH_OLLAMA_API_KEY'
const contexts: Context[] = []

async function harness(): Promise<Context> {
  if (baseURL === undefined) throw new Error('DSH_OLLAMA_BASE_URL is required')

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      'ollama-local': {
        apiKeyEnv: credentialRef,
        displayName: 'Ollama (local)',
        api: 'openai-completions',
        baseURL,
        models: [{ id: model, name: model, contextWindow: 32_768, maxTokens: 64 }],
      },
    },
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe.skipIf(baseURL === undefined || process.env[credentialRef] === undefined)(
  'DSH Agent with a local Ollama model route',
  () => {
    it('completes one Agent turn and commits the model response to its Session', async () => {
      const ctx = await harness()
      const agent = await ctx.agentLoop.create(SessionId('ollama-local-agent-e2e'), {
        provider: 'ollama-local',
        model,
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Reply with exactly the word PONG and no punctuation.' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      const assistant = agent.session.deriveMessages().findLast(message => message.role === 'assistant')
      const response = assistant?.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      expect(response).toMatch(/pong/i)
      expect(agent.session.snapshotEvents().at(-1)?.type).toBe('turn/end')
    })
  },
)
