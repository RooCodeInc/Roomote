'use client';

import { AutomationsSettings } from '@/components/settings/automations';
import { DeploymentTimeZoneSetting } from '@/components/settings/DeploymentTimeZoneSetting';
import { useAuthorizedUser } from '@/hooks/useUser';
import { DOCS_COOKBOOK_URL } from '@/lib/docs';
import { PRODUCT_NAME } from '@roomote/types';

import {
  Alert,
  AlertCircle,
  AlertDescription,
  BookOpenText,
  HeaderCallout,
} from '@/components/system';

export function AutomationsSettingsPage() {
  const { isAdmin } = useAuthorizedUser();

  return (
    <div className="min-h-full w-full overflow-auto bg-background px-4 py-8 md:px-8">
      <div className="max-w-8xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-foreground">
              Automations
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground hidden md:block">
              Get {PRODUCT_NAME} automatically working on your behalf.
            </p>
          </div>
          <HeaderCallout
            icon={BookOpenText}
            text="Unsure how automations can help?"
            action={DOCS_COOKBOOK_URL}
            buttonLabel="Explore recipes"
          />
        </header>

        {isAdmin ? (
          <>
            <DeploymentTimeZoneSetting />
            <AutomationsSettings />
          </>
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
