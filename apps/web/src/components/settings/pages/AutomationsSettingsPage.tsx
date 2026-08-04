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
  Button,
  Lightbulb,
} from '@/components/system';

export function AutomationsSettingsPage() {
  const { isAdmin } = useAuthorizedUser();

  return (
    <div className="min-h-full w-full overflow-auto bg-background p-8">
      <div className="max-w-6xl space-y-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-foreground">
              Automations
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Get {PRODUCT_NAME} automatically working on your behalf.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <Lightbulb className="size-4 shrink-0 text-muted-foreground" />
            <span>Unsure how automations can help?</span>
            <Button asChild variant="outline" size="xs">
              <a
                href={DOCS_COOKBOOK_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Explore recipes
              </a>
            </Button>
          </div>
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
