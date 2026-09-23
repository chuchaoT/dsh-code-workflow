import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-experimental-autodev/remote'
import autodevRemote from '@deepseek-ai/dsh-experimental-autodev/remote'
import { AutoDevPanel, type AutoDevPanelInjected } from './AutoDevPanel.tsx'
import { autoDevDefinition, AUTODEV_KIND, AUTODEV_TAB_ID } from './definition.ts'
import { en, zh, type AutoDevKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    autodev: AutoDevKey
  }
}

const NS = 'autodev'

export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'remote', 'commandUi']

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(autodevRemote)
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'autodev client dictionaries')
  ctx.effect(() => ctx.sidebarRightTabs.register(autoDevDefinition(() => t('title'), () => t('description'))), 'autodev client tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: AUTODEV_TAB_ID,
    locale: NS,
    inject: (): AutoDevPanelInjected => ({ remote: ctx.remote.autodev }),
  }, AutoDevPanel)), 'autodev client tab body')
  ctx.inject(['commandUi'], scope => scope.effect(() => scope.commandUi.register({
    name: 'autodev',
    label: () => t('commandLabel'),
    description: () => t('commandDescription'),
    available: () => true,
    ui: { kind: 'action', run: (session) => { ctx.sidebarRight.openTabIn(session.sessionId, AUTODEV_KIND) } },
  }), 'autodev client command'))
  return async () => { await disposeRemote() }
}
