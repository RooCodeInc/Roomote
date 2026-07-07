import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { EnvironmentsSettingsPage } from '@/components/settings/pages/EnvironmentsSettingsPage';

export default async function Page() {
  await bootstrapWebRuntimeEnv();

  return <EnvironmentsSettingsPage />;
}
