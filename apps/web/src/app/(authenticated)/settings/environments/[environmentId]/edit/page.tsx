import { EditEnvironmentSettingsPage } from './EditEnvironmentSettingsPage';

export default async function Page({
  params,
}: {
  params: Promise<{ environmentId: string }>;
}) {
  const { environmentId } = await params;

  return <EditEnvironmentSettingsPage environmentId={environmentId} />;
}
