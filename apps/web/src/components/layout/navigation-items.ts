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
    href: '/sessions',
    label: 'Sessions',
    description: 'View current and past conversations',
    matchExact: false,
    matchPaths: ['/sessions', '/tasks', '/cloud-agents'],
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
  setupIncomplete?: boolean;
}): PrimaryNavItem[] {
  return PRIMARY_NAV_ITEMS.filter(
    (item) =>
      (!item.adminOnly || opts.isAdmin) &&
      (!opts.setupIncomplete || item.href === '/sessions'),
  );
}
