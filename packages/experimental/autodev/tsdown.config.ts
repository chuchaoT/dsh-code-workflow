import type { UserConfig } from 'tsdown'
import { typertPlugin } from '../../typert/generator/lib/types/tsdown-plugin.js'
import { clientBundle } from '../../client/tsdown.client.ts'

const base = clientBundle(
  '@deepseek-ai/dsh-experimental-autodev',
  ['lib/types/index.js', 'lib/types/contracts.js', 'lib/types/router.js'],
  { hostPhase: true },
)

/** Keep standalone package builds capable of emitting the Host Typert and Remote faces. */
export default (context: Pick<UserConfig, 'env'>): UserConfig[] => {
  const configs = base(context)
  if (context.env?.DSH_BUILD_FACE === 'client') return configs
  return configs.map(config => config.platform === 'node'
    ? {
        ...config,
        plugins: [...(config.plugins ?? []), typertPlugin({ mode: 'package', faces: ['host'] })],
      }
    : config)
}
