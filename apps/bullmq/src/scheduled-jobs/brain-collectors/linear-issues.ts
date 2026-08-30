import { BRAIN_COLLECTOR_IDS } from '@roomote/types';

import {
  backfillBrainLinearIssuesStep,
  collectBrainLinearIssues,
  isBrainSourceAvailable,
} from '@roomote/sdk/server';

import type { BrainCollector } from './contracts';

/**
 * Linear issues are durable product context. The SDK collector reuses the
 * deployment OAuth connection, keeps comments bounded inside each issue page,
 * and performs periodic complete visibility sweeps before retiring pages.
 */
export const linearIssuesCollector: BrainCollector = {
  id: BRAIN_COLLECTOR_IDS.linearIssues,
  displayName: 'Linear issues',
  async isEnabled() {
    return isBrainSourceAvailable('linear');
  },
  async collect({ now, limit }) {
    return collectBrainLinearIssues({ now, limit });
  },
  async backfill({ cursor, limit }) {
    return backfillBrainLinearIssuesStep({ cursor, limit });
  },
};
