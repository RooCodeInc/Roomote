import type { ReactNode } from 'react';

import { PAGE_METADATA } from '@/lib/metadata';

import { SetupLayoutClient } from './SetupLayoutClient';

export const metadata = PAGE_METADATA.setup;

export default function SetupLayout({ children }: { children: ReactNode }) {
  return <SetupLayoutClient>{children}</SetupLayoutClient>;
}
