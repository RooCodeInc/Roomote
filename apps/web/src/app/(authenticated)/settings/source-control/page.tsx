import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { SourceControlSettingsPage } from '@/components/settings/pages/SourceControlSettingsPage';

export default async function Page() {
  await bootstrapWebRuntimeEnv();

  return <SourceControlSettingsPage />;
}
