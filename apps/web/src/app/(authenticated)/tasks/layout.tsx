import type { ReactNode } from 'react';

import { PAGE_METADATA } from '@/lib/metadata';

export const metadata = PAGE_METADATA.taskHistory;

export default function TasksLayout({ children }: { children: ReactNode }) {
  return children;
}
