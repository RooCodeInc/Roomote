'use client';

import { AutomationsSettings } from '@/components/settings/automations';
import { useAuthorizedUser } from '@/hooks/useUser';
import { PRODUCT_NAME } from '@roomote/types';

import { Alert, AlertCircle, AlertDescription } from '@/components/system';

export function AutomationsSettingsPage() {
  const { isAdmin } = useAuthorizedUser();

  return (
    <div className="min-h-full w-full overflow-auto bg-background p-8">
      <div className="max-w-6xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">
            Automations
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Get {PRODUCT_NAME} automatically working on your behalf.
          </p>
        </header>

        {isAdmin ? (
          <AutomationsSettings />
        ) : (
          <Alert>
            <AlertCircle className="size-4" />
            <AlertDescription>
              Only admins can access this page.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
