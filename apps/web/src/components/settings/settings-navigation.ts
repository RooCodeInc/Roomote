import type { LucideIcon } from '@/components/system';
import {
  BookOpenText,
  Cpu,
  FlaskConical,
  GraduationCap,
  Layers,
  GitMerge,
  IdCard,
  MessagesSquare,
  PlugIcon,
  ScrollText,
  ServerCog,
  Users,
  VectorSquare,
} from '@/components/system';
import { SETTINGS_PATHS } from '@/lib/settings';

export type SettingsPageId =
  | 'personal'
  | 'users'
  | 'environments'
  | 'agent-guidance'
  | 'automations'
  | 'integrations'
  | 'comms'
  | 'compute'
  | 'source-control'
  | 'models'
  | 'memory'
  | 'skills'
  | 'experimental'
  | 'misc';

type SettingsNavigationItem = {
  id: SettingsPageId;
  label: string;
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  hiddenWhenCloud?: boolean;
  /** Shown only on deployments where Memory is wired or enabled. */
  requiresBrain?: boolean;
  newGroup?: boolean;
  matches: (pathname: string) => boolean;
};

const SETTINGS_NAVIGATION_ITEMS: SettingsNavigationItem[] = [
  {
    id: 'personal',
    label: 'Personal',
    title: 'Personal',
    description: 'Manage your profile and linked app accounts.',
    href: SETTINGS_PATHS.personal,
    icon: IdCard,
    matches: (pathname) =>
      pathname === SETTINGS_PATHS.root || pathname === SETTINGS_PATHS.personal,
  },
  {
    id: 'models',
    label: 'Models',
    title: 'Models',
    description:
      'Choose your inference provider, which task models are enabled, and which one is the default.',
    href: SETTINGS_PATHS.models,
    icon: Layers,
    adminOnly: true,
    newGroup: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.models),
  },
  {
    id: 'comms',
    label: 'Communications',
    title: 'Communications',
    description:
      'Configure the communications providers (Slack, Teams, Telegram) this deployment can use.',
    href: SETTINGS_PATHS.comms,
    icon: MessagesSquare,
    adminOnly: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.comms),
  },
  {
    id: 'compute',
    label: 'Sandboxes',
    title: 'Sandboxes',
    description:
      'Configure the sandbox providers that run tasks and choose the default.',
    href: SETTINGS_PATHS.compute,
    icon: Cpu,
    adminOnly: true,
    hiddenWhenCloud: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.compute),
  },
  {
    id: 'source-control',
    label: 'Source Control',
    title: 'Source Control',
    description:
      'Configure source control providers and default pull request delivery behavior.',
    href: SETTINGS_PATHS.sourceControl,
    icon: GitMerge,
    adminOnly: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.sourceControl),
  },
  {
    id: 'integrations',
    label: 'Integrations',
    title: 'Integrations',
    description:
      'Enable deployment integrations. Individual users can optionally link their own accounts when an integration supports it.',
    href: SETTINGS_PATHS.integrations,
    icon: PlugIcon,
    adminOnly: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.integrations),
  },
  {
    id: 'memory',
    label: 'Memory',
    title: 'Memory',
    description:
      'The shared memory agents read before they start: what it has learned, where it learns from, and how ingestion is doing.',
    href: SETTINGS_PATHS.memory,
    icon: BookOpenText,
    adminOnly: true,
    requiresBrain: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.memory),
  },
  {
    id: 'environments',
    label: 'Environments',
    title: 'Environments',
    description: 'Manage environments and environment variables.',
    href: SETTINGS_PATHS.environments,
    icon: VectorSquare,
    adminOnly: true,
    newGroup: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.environments),
  },
  {
    id: 'agent-guidance',
    label: 'Agent Guidance',
    title: 'Agent Guidance',
    description:
      'Configure shared instructions that apply to every task in this workspace.',
    href: SETTINGS_PATHS.agentGuidance,
    icon: ScrollText,
    adminOnly: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.agentGuidance),
  },

  {
    id: 'skills',
    label: 'Skills',
    title: 'Skills',
    description: 'Add agent skills to your environments.',
    href: SETTINGS_PATHS.skills,
    icon: GraduationCap,
    adminOnly: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.skills),
  },
  {
    id: 'users',
    label: 'Users',
    title: 'Users',
    description: 'Manage access to this Roomote deployment.',
    href: SETTINGS_PATHS.users,
    icon: Users,
    adminOnly: true,
    newGroup: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.users),
  },
  {
    id: 'experimental',
    label: 'Experimental',
    title: 'Experimental',
    description:
      'Early features you can opt in to for this deployment. They may change or be removed.',
    href: SETTINGS_PATHS.experimental,
    icon: FlaskConical,
    adminOnly: true,
    newGroup: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.experimental),
  },
  {
    id: 'misc',
    label: 'Deployment',
    title: 'Deployment',
    description: 'Deployment-wide settings and diagnostics.',
    href: SETTINGS_PATHS.misc,
    icon: ServerCog,
    adminOnly: true,
    matches: (pathname) => pathname.startsWith(SETTINGS_PATHS.misc),
  },
];

export function getAccessibleSettingsNavigation(opts: {
  isAdmin: boolean;
  cloudEnabled: boolean;
  brainConfigured?: boolean;
}) {
  return SETTINGS_NAVIGATION_ITEMS.filter((item) => {
    if (item.adminOnly && !opts.isAdmin) {
      return false;
    }
    if (item.hiddenWhenCloud && opts.cloudEnabled) {
      return false;
    }
    if (item.requiresBrain && !opts.brainConfigured) {
      return false;
    }
    return true;
  });
}

export function getSettingsNavigationItem(pageId: SettingsPageId) {
  return SETTINGS_NAVIGATION_ITEMS.find((item) => item.id === pageId);
}

export function getSettingsTitleForPath(pathname: string) {
  if (pathname === SETTINGS_PATHS.root) {
    return 'Settings';
  }

  return SETTINGS_NAVIGATION_ITEMS.find((item) => item.matches(pathname))
    ?.title;
}
