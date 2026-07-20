import {
  resolveComputeProviderSelection,
  resolveDefaultComputeProvider,
} from '@roomote/db/server';

import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { Env, isRoomoteCloudEnabled } from '@/lib/server/env';
import { Home } from './home/Home';
import { getRandomHomePromptPlaceholderIndex } from './home/promptPlaceholders';

export default async function Page() {
  await bootstrapWebRuntimeEnv();

  const { defaultComputeProvider, availableComputeProviders } =
    isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED)
      ? await resolveDefaultComputeProvider().then((provider) => ({
          defaultComputeProvider: provider,
          availableComputeProviders: [provider],
        }))
      : await resolveComputeProviderSelection();

  return (
    <Home
      initialPlaceholderIndex={getRandomHomePromptPlaceholderIndex()}
      defaultComputeProvider={defaultComputeProvider}
      availableComputeProviders={availableComputeProviders}
    />
  );
}
