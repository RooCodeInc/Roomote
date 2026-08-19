import {
  backfillBrainGithubIssuesStep,
  collectBrainGithubIssues,
  hasBrainGithubSources,
} from '@roomote/sdk/server';

import type { BrainCollector } from './contracts';

/**
 * GitHub issues: the bug reports, feature discussions, and decisions that the
 * merged-PR facts mirror (prs/ pages) does not carry. Reads use the
 * deployment's own GitHub App installation, so the corpus stays within what
 * Roomote can already see in connected repositories. All upstream failures
 * are absorbed in the SDK layer as no-progress results, so a GitHub rate
 * limit can never masquerade as brain-side backpressure.
 */
export const githubIssuesCollector: BrainCollector = {
  // Version when date semantics change so the deep backfill rewrites history.
  id: 'github-issues:occurrence-date-v3',
  displayName: 'GitHub issues',
  async isEnabled() {
    return hasBrainGithubSources();
  },
  async collect({ now, limit }) {
    return collectBrainGithubIssues({ now, limit });
  },
  async backfill({ cursor }) {
    return backfillBrainGithubIssuesStep({ cursor });
  },
};
