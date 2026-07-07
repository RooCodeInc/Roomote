import type { ReactNode } from 'react';

import { Info } from './icons';

export function EnvVarsInfoNote({
  runtimeConfigured = false,
  children,
}: {
  runtimeConfigured?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 text-muted-foreground mt-4">
      <Info className="inline size-4 mt-0.5 shrink-0" />
      <p className="text-sm">
        {children ??
          (runtimeConfigured
            ? "These values are being passed via ENV vars and can't be overridden here."
            : "You can pass these in as ENV vars. When configured here, they're encrypted in the database.")}
      </p>
    </div>
  );
}
