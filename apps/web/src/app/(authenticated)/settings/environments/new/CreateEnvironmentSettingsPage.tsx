'use client';

import { useRouter } from 'next/navigation';

import { CreateEnvironmentPage } from '@/components/settings/environments';
import { SETTINGS_PATHS } from '@/lib/settings';

export function CreateEnvironmentSettingsPage() {
  const router = useRouter();

  return (
    <CreateEnvironmentPage
      onCancel={() => router.push(SETTINGS_PATHS.environments)}
      onCreated={() => router.push(SETTINGS_PATHS.environments)}
    />
  );
}
