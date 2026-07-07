'use client';

import { useRouter } from 'next/navigation';

import { EditEnvironmentPage } from '@/components/settings/environments';
import { SETTINGS_PATHS } from '@/lib/settings';

function addEnvironmentToPath(path: string, environmentId: string) {
  const url = new URL(path, 'https://roomote.local');
  url.searchParams.set('environmentId', environmentId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function EditEnvironmentSettingsPage({
  environmentId,
}: {
  environmentId: string;
}) {
  const router = useRouter();

  return (
    <EditEnvironmentPage
      environmentId={environmentId}
      onCancel={() => router.push(SETTINGS_PATHS.environments)}
      onUpdated={() => router.push(SETTINGS_PATHS.environments)}
      onGoUseIt={(updatedEnvironmentId) =>
        router.push(addEnvironmentToPath('/', updatedEnvironmentId))
      }
    />
  );
}
