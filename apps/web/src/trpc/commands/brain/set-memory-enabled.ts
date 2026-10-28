import { setBrainEnabled } from '@roomote/db/server';
import { requestBrainBackfill } from '@roomote/sdk/server';
import type { UserAuthSuccess } from '@/types';

import { assertAdmin } from '../setup/shared';

/**
 * Turn the Brain on or off for the deployment. Writes the explicit Settings
 * choice, which from then on wins over the legacy R_BRAIN_* key fallback.
 */
export async function setMemoryEnabledCommand(
  auth: UserAuthSuccess,
  input: { enabled: boolean },
): Promise<{ enabled: boolean }> {
  assertAdmin(auth);

  await setBrainEnabled(input.enabled);

  if (input.enabled) {
    // Start the initial backfill now rather than waiting out the 15-minute
    // collector schedules: a freshly enabled Memory should show content
    // landing within moments.
    void requestBrainBackfill('memory-enabled');
  }

  return { enabled: input.enabled };
}
