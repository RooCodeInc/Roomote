import { createHash } from 'node:crypto';

import { readRecentBrainTaskMemories } from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import { suggestHomeComposerMessages } from '@/lib/server/composer-suggestion';

const RECENT_MEMORY_LIMIT = 5;

/** Build home placeholders from recent task memories, failing soft to none. */
export async function getHomeComposerSuggestionsCommand(
  auth: UserAuthSuccess,
): Promise<{ suggestions: string[] }> {
  try {
    const memories = await readRecentBrainTaskMemories({
      userId: auth.userId,
      limit: RECENT_MEMORY_LIMIT,
    });

    if (memories.length === 0) {
      return { suggestions: [] };
    }

    const revision = createHash('sha256')
      .update(
        memories
          .map(
            (memory) =>
              `${memory.slug}:${memory.updatedAt?.toISOString() ?? ''}`,
          )
          .join('|'),
      )
      .digest('hex');

    return await suggestHomeComposerMessages({
      memories: memories.map((memory) => memory.content),
      revision,
      userId: auth.userId,
    });
  } catch (error) {
    console.error('Error loading home composer suggestion context:', error);
    return { suggestions: [] };
  }
}
