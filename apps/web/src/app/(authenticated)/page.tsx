import { resolveDefaultComputeProvider } from '@roomote/db/server';

import { bootstrapWebRuntimeEnv } from '@/lib/server/bootstrap-runtime-env';
import { Home } from './home/Home';
import { getRandomHomePromptPlaceholderIndex } from './home/promptPlaceholders';

export default async function Page() {
  await bootstrapWebRuntimeEnv();

  return (
    <Home
      initialPlaceholderIndex={getRandomHomePromptPlaceholderIndex()}
      defaultComputeProvider={await resolveDefaultComputeProvider()}
    />
  );
}
