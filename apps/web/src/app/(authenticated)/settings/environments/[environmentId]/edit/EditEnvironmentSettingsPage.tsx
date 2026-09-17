'use client';

import { useRouter } from 'next/navigation';

import { EditEnvironmentPage } from '@/components/settings/environments';
import { SETTINGS_PATHS } from '@/lib/settings';

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
    />
  );
}
