'use client';

import { SettingsShell } from '@/components/settings/SettingsShell';
import { EnvVars } from '@/components/settings/EnvVars';
import { Environments } from '@/components/settings/environments';
import { DOCS_ENVIRONMENT_DEFINITION_URL } from '@/lib/docs';

export function EnvironmentsSettingsPage() {
  return (
    <SettingsShell pageId="environments" adminOnly={true}>
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Learn about environments and how to configure them in the{' '}
          <a
            href={DOCS_ENVIRONMENT_DEFINITION_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-4"
          >
            docs
          </a>
          .
        </p>
        <Environments />
        <EnvVars />
      </div>
    </SettingsShell>
  );
}
