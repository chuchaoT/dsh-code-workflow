import { DecisionCoordinator } from '../src/jev.ts'

/** Offline model boundary for orchestration tests; production fallback remains explicitly untrusted. */
export function trustedTestDecisions(): DecisionCoordinator {
  return new DecisionCoordinator({
    config: { mode: 'required' },
    provider: {
      async evaluate(request) {
        const answers = request.questions.map((question) => {
          if (question.type === 'choice') {
            const value = question.id === 'completion' ? 'ready_for_verify' : question.choices?.[0] ?? 'human'
            return { questionId: question.id, kind: 'choice' as const, value, probability: 1 }
          }
          if (question.type === 'score') return { questionId: question.id, kind: 'score' as const, value: question.max ?? 100, probability: 1 }
          return { questionId: question.id, kind: 'noul' as const, value: false, probability: 1 }
        })
        return { source: 'jev' as const, providerId: 'offline-model-fixture', modelVersion: 'offline-fixture-v1', answers }
      },
    },
  })
}
