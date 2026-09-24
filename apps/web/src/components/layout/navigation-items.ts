import { type LucideIcon } from '@/components/system';
import {
  ChartColumnIncreasing,
  House,
  MessagesSquare,
  Plug,
  NotepadText,
  Zap,
} from '@/components/system';

/**
 * Groups items in the desktop side nav: `home` and `sessions` share the first
 * group around the New Session action, `manage` ends with Settings, and
 * `insights` renders as its own group when it has visible items.
 */
type SideNavSection = 'home' | 'sessions' | 'manage' | 'insights';

export interface PrimaryNavItem {
  icon: LucideIcon;
  href: string;
  label: string;
  mobileLabel?: string;
  description: string;
  matchExact: boolean;
  matchPaths: string[];
  sideNavSection: SideNavSection;
  adminOnly?: boolean;
}

const PRIMARY_NAV_ITEMS: PrimaryNavItem[] = [
  {
    icon: House,
    href: '/',
    label: 'Home',
    description: 'Start here',
    matchExact: true,
    matchPaths: ['/'],
    sideNavSection: 'home',
  },
  {
    icon: MessagesSquare,
    href: '/sessions',
    label: 'Sessions',
    description: 'View current and past conversations',
    matchExact: false,
    matchPaths: ['/sessions', '/tasks', '/cloud-agents'],
    sideNavSection: 'sessions',
  },
  {
    icon: Zap,
    href: '/automations',
    label: 'Automations',
    description: 'Configure background work that runs for your team',
    matchExact: false,
    matchPaths: ['/automations'],
    sideNavSection: 'manage',
  },
  {
    icon: NotepadText,
    href: '/results',
    label: 'Results',
    description: 'Review automation reports and suggested follow-ups',
    matchExact: false,
    matchPaths: ['/results'],
    sideNavSection: 'manage',
  },
  {
    icon: Plug,
    href: '/integrations',
    label: 'Integrations',
    description: 'Connect Roomote with tools your team uses',
    matchExact: false,
    matchPaths: ['/integrations'],
    sideNavSection: 'manage',
  },
  {
    icon: ChartColumnIncreasing,
    href: '/analytics',
    label: 'Analytics',
    description: 'View analytics',
    matchExact: false,
    matchPaths: ['/analytics'],
    sideNavSection: 'insights',
    adminOnly: true,
  },
];

export function getVisiblePrimaryNavItems(opts: {
  isAdmin: boolean;
}): PrimaryNavItem[] {
  return PRIMARY_NAV_ITEMS.filter((item) => !item.adminOnly || opts.isAdmin);
}

export function getVisibleSideNavSections(opts: {
  isAdmin: boolean;
}): Record<SideNavSection, PrimaryNavItem[]> {
  const sections: Record<SideNavSection, PrimaryNavItem[]> = {
    home: [],
    sessions: [],
    manage: [],
    insights: [],
  };

  for (const item of getVisiblePrimaryNavItems(opts)) {
    sections[item.sideNavSection].push(item);
  }

  return sections;
}
