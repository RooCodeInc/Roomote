import { type LucideIcon } from '@/components/system';
import { ChartColumnIncreasing, House, Zap } from '@/components/system';
import { Rows4 } from 'lucide-react';

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
    icon: Zap,
    href: '/automations',
    label: 'Automations',
    description: 'Configure background work that runs for your team',
    matchExact: false,
    matchPaths: ['/automations'],
    adminOnly: true,
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
}): PrimaryNavItem[] {
  return PRIMARY_NAV_ITEMS.filter((item) => !item.adminOnly || opts.isAdmin);
}
