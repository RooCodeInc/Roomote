import type { ReactNode } from 'react';

import { PAGE_METADATA } from '@/lib/metadata';

export const metadata = PAGE_METADATA.settings;

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return children;
}
