import type { ReactNode } from 'react';

interface HistoricalSandboxProviderProps {
  taskId: string | null;
  fallback?: ReactNode;
  children: ReactNode;
}

export function HistoricalSandboxProvider({
  taskId: _taskId,
  fallback,
  children,
}: HistoricalSandboxProviderProps) {
  return <>{fallback ?? children}</>;
}
