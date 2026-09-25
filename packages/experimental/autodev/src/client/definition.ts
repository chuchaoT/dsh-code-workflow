import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** Stable owner ID used to register and route the AutoDev sidebar tab. */
export const AUTODEV_TAB_ID = '@deepseek-ai/dsh-experimental-autodev'
/** Sidebar contribution kind rendered by the AutoDev Client package. */
export const AUTODEV_KIND = 'autodev'

/** Build the AutoDev sidebar tab with labels resolved by the active locale.
 * @param title - Callback that returns the localized tab title.
 * @param description - Callback that returns the localized guide text.
 * @returns The Client sidebar tab definition.
 */
export function autoDevDefinition(title: () => string, description: () => string): SidebarRightTabDefinition {
  return {
    id: AUTODEV_TAB_ID,
    kind: AUTODEV_KIND,
    title,
    guide: [{ id: 'open', order: 15, title, description }],
  }
}
