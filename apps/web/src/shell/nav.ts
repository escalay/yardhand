/** The app's places: the six tabs of the frame, and everything ⌘K can go to. */
import {
  type Icon,
  IconActivity,
  IconChecklist,
  IconHome,
  IconKey,
  IconPlug,
  IconSettings,
  IconStack2,
  IconTool,
} from '@tabler/icons-react'

export type Place = {
  to: '/' | '/connections' | '/tools' | '/packs' | '/agents' | '/activity' | '/tools/reviews' | '/settings'
  label: string
  icon: Icon
  /** What it holds, said in the palette. */
  hint: string
}

/** The frame's tabs, one per job: the hub, connect, curate, kits, grant, watch. */
export const TABS: Place[] = [
  { to: '/', label: 'Overview', icon: IconHome, hint: 'What needs you, and how calls went' },
  { to: '/connections', label: 'Connections', icon: IconPlug, hint: 'The servers and APIs behind Yardhand' },
  { to: '/tools', label: 'Tools', icon: IconTool, hint: 'Every tool, reviews of changes, and pins' },
  {
    to: '/packs',
    label: 'Packs',
    icon: IconStack2,
    hint: 'Kits of tools for one kind of work, and keys locked to them',
  },
  { to: '/agents', label: 'Agents', icon: IconKey, hint: 'Keys, what each reaches, and setup' },
  { to: '/activity', label: 'Activity', icon: IconActivity, hint: 'Every call and search, live' },
]

export const PLACES: Place[] = [
  ...TABS,
  { to: '/tools/reviews', label: 'Reviews', icon: IconChecklist, hint: 'Changes waiting for you' },
  { to: '/settings', label: 'Settings', icon: IconSettings, hint: 'Backups, export, Yardhand itself' },
]

/** Which place a path belongs to: a tab, or Settings (the gear beside them). */
export const tabOf = (path: string) =>
  path === '/'
    ? '/'
    : (TABS.find((tab) => tab.to !== '/' && path.startsWith(tab.to))?.to ??
      (path.startsWith('/reviews') ? '/tools' : path.startsWith('/settings') ? '/settings' : '/'))
