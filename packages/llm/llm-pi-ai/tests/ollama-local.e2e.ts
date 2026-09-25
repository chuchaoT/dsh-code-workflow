import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'

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
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe.skipIf(baseURL === undefined || process.env[credentialRef] === undefined)(
  'llm-pi-ai Ollama local endpoint e2e',
  () => {
    it('streams a real response through the DSH LLM service', async () => {
      const ctx = await harness()
      const result = await assemble(ctx, {
        provider: 'ollama-local',
        model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'Reply with exactly the word PONG and no punctuation.' }],
          source: { kind: 'model', provider: 'ollama-local', model },
        })],
        maxTokens: 32,
      })

      expect(result.finish.kind).toBe('stop')
      expect(result.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join(''))
        .toMatch(/pong/i)
    })
  },
)
