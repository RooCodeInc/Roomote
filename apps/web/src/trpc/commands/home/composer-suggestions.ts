import { createHash } from 'node:crypto';

import { unstable_cache } from 'next/cache';
import {
  listRecentBrainTaskMemoryRefs,
  readBrainTaskMemories,
} from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';
import {
  HOME_SUGGESTIONS_CACHE_VERSION,
  suggestHomeComposerMessages,
} from '@/lib/server/composer-suggestion';
import { getPersonalPreferencesCommand } from '../preferences';

const RECENT_MEMORY_LIMIT = 5;
const CACHE_TTL_SECONDS = 24 * 60 * 60;

class HomeComposerSuggestionsUnavailableError extends Error {}

/** Build home placeholders from recent task memories, failing soft to none. */
export async function getHomeComposerSuggestionsCommand(
  auth: UserAuthSuccess,
): Promise<{ suggestions: string[] }> {
  try {
    const preferences = await getPersonalPreferencesCommand(auth);
    if (!preferences.homeComposerSuggestionsEnabled) {
      return { suggestions: [] };
    }

    const memoryRefs = await listRecentBrainTaskMemoryRefs({
      userId: auth.userId,
      limit: RECENT_MEMORY_LIMIT,
    });

    if (memoryRefs.length === 0) {
      return { suggestions: [] };
    }

    const revision = createHash('sha256')
      .update(
        memoryRefs
          .map(
            (memory) =>
              `${memory.taskId}:${memory.runId}:${memory.memoryRevision}`,
          )
          .join('|'),
      )
      .digest('hex');

    const loadSuggestions = unstable_cache(
      async () => {
        const memories = await readBrainTaskMemories(memoryRefs);
        const result = await suggestHomeComposerMessages({
          memories: memories.map((memory) => memory.content),
          revision,
          userId: auth.userId,
        });

        // Do not turn a transient Brain/helper failure into a 24-hour miss.
        if (result.suggestions.length === 0) {
          throw new HomeComposerSuggestionsUnavailableError();
        }

        return result;
      },
      [
        'home-composer-suggestion-context',
        HOME_SUGGESTIONS_CACHE_VERSION,
        auth.userId,
        revision,
      ],
      { revalidate: CACHE_TTL_SECONDS },
    );

    return await loadSuggestions();
  } catch (error) {
    if (!(error instanceof HomeComposerSuggestionsUnavailableError)) {
      console.error('Error loading home composer suggestion context:', error);
    }
    return { suggestions: [] };
  }
}
