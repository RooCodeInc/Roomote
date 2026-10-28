import { readBrainCorpus } from '@roomote/sdk/server';
import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';
import {
  paginateBrainCorpus,
  type BrainPageListing,
} from './paginate-brain-corpus';

/**
 * One server-filtered page from the exhaustive cached corpus. The browser
 * only renders this bounded result, so searching a large Brain does not
 * ship the full listing on every keystroke.
 */
export async function listBrainPagesCommand(
  auth: UserAuthSuccess,
  input: {
    search?: string;
    namespaceId?: string;
    offset: number;
    limit: number;
  },
): Promise<BrainPageListing> {
  assertAdmin(auth);

  const snapshot = await readBrainCorpus();

  if (!snapshot) {
    return { reachable: false, total: 0, nextOffset: null, pages: [] };
  }

  return { reachable: true, ...paginateBrainCorpus(snapshot, input) };
}
