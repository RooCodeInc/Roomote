import type { ReactNode } from 'react';

import { PAGE_METADATA } from '@/lib/metadata';

export const metadata = PAGE_METADATA.task;

export default function TaskLayout({ children }: { children: ReactNode }) {
  return children;
}
