import { type LucideIcon } from '@/components/system';
import { ChartColumnIncreasing, House, Rows4, Zap } from '@/components/system';

interface PrimaryNavItem {
  icon: LucideIcon;
  href: string;
  label: string;
  mobileLabel?: string;
  description: string;
  matchExact: boolean;
  matchPaths: string[];
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
  },
  {
    icon: Rows4,
    href: '/tasks',
    label: 'Tasks',
    description: 'View current and past tasks',
    matchExact: false,
    matchPaths: ['/tasks', '/cloud-agents'],
  },
  {
    icon: Zap,
    href: '/automations',
    label: 'Automations',
    description: 'Configure background work that runs for your team',
    matchExact: false,
    matchPaths: ['/automations'],
    adminOnly: true,
  },
  {
    icon: ChartColumnIncreasing,
    href: '/analytics',
    label: 'Analytics',
    description: 'View analytics',
    matchExact: false,
    matchPaths: ['/analytics'],
    adminOnly: true,
  },
];

export function getVisiblePrimaryNavItems(opts: {
  isAdmin: boolean;
  sessionsUi?: boolean;
}): PrimaryNavItem[] {
  return PRIMARY_NAV_ITEMS.map((item) =>
    item.href === '/tasks' && opts.sessionsUi
      ? {
          ...item,
          href: '/sessions',
          label: 'Sessions',
          description: 'View conversations and delegated work',
          matchPaths: ['/sessions', '/tasks', '/cloud-agents'],
        }
      : item,
  ).filter((item) => !item.adminOnly || opts.isAdmin);
}
