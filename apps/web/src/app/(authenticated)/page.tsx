import {
  listConfiguredComputeProviders,
  resolveDefaultComputeProvider,
} from '@roomote/db/server';

import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { Home } from './home/Home';
import { getRandomHomePromptPlaceholderIndex } from './home/promptPlaceholders';

export default async function Page() {
  await bootstrapWebRuntimeEnv();

  const [defaultComputeProvider, availableComputeProviders] = await Promise.all(
    [resolveDefaultComputeProvider(), listConfiguredComputeProviders()],
  );

  return (
    <Home
      initialPlaceholderIndex={getRandomHomePromptPlaceholderIndex()}
      defaultComputeProvider={defaultComputeProvider}
      availableComputeProviders={availableComputeProviders}
    />
  );
}
