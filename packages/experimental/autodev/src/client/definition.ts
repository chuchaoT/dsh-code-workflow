import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

export const AUTODEV_TAB_ID = '@deepseek-ai/dsh-experimental-autodev'
export const AUTODEV_KIND = 'autodev'

export function autoDevDefinition(title: () => string, description: () => string): SidebarRightTabDefinition {
  return {
    id: AUTODEV_TAB_ID,
    kind: AUTODEV_KIND,
    title,
    guide: [{ id: 'open', order: 15, title, description }],
  }
}
