'use client';

import { useRouter } from 'next/navigation';

import { CreateEnvironmentPage } from '@/components/settings/environments';
import { SETTINGS_PATHS } from '@/lib/settings';

function addEnvironmentToPath(path: string, environmentId: string) {
  const url = new URL(path, 'https://roomote.local');
  url.searchParams.set('environmentId', environmentId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function CreateEnvironmentSettingsPage() {
  const router = useRouter();

  return (
    <CreateEnvironmentPage
      onCancel={() => router.push(SETTINGS_PATHS.environments)}
      onCreated={(createdEnvironment) =>
        router.push(addEnvironmentToPath('/', createdEnvironment.id))
      }
    />
  );
}
