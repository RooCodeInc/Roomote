import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AUTOMATION_RECOMMENDATION_CATALOG,
  isAutomationRecommendationDeliveryEligible,
  scoreAutomationRecommendations,
  type MergedAutomationRecommendationSignals,
} from './automation-recommendations';

const signals: MergedAutomationRecommendationSignals = {
  repositoryCount: 2,
  sourceControlProviders: ['github'],
  mergedPrs30d: 12,
  openPrs: 4,
  conflicts: 2,
  ciFailures30d: 3,
  dependabotAlerts: 3,
  codeqlAlerts: 0,
  dependencyManifests: 2,
  docs: 1,
};

describe('scoreAutomationRecommendations', () => {
  it('is deterministic and pins Review Code first', () => {
    const first = scoreAutomationRecommendations(signals, {
      reportProvider: 'slack',
    });
    const second = scoreAutomationRecommendations(signals, {
      reportProvider: 'slack',
    });

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.length).toBeLessThanOrEqual(6);
    expect(first[0]?.candidate.id).toBe('built-in.review-code');
    expect(first.every(({ explanation }) => explanation.length > 0)).toBe(true);
  });

  it('removes enabled candidates and caps categories', () => {
    const result = scoreAutomationRecommendations(signals, {
      enabledCandidateIds: new Set(['built-in.resolve-pr-conflicts']),
      reportProvider: 'slack',
    });

    expect(
      result.some(
        ({ candidate }) => candidate.id === 'built-in.resolve-pr-conflicts',
      ),
    ).toBe(false);
    const categoryCounts = new Map<string, number>();
    for (const item of result) {
      categoryCounts.set(
        item.candidate.category,
        (categoryCounts.get(item.candidate.category) ?? 0) + 1,
      );
    }
    expect([...categoryCounts.values()].every((count) => count <= 2)).toBe(
      true,
    );
  });

  it('supports sparse data with candidate-specific fallback copy', () => {
    const result = scoreAutomationRecommendations(
      {
        ...signals,
        mergedPrs30d: 0,
        openPrs: 0,
        conflicts: 0,
        ciFailures30d: 0,
        dependabotAlerts: 0,
        dependencyManifests: 0,
        docs: 0,
      },
      { reportProvider: 'slack' },
    );

    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.length).toBeLessThanOrEqual(6);
    expect(
      result.find(
        ({ candidate }) => candidate.id === 'built-in.ci-failure-triage',
      )?.explanation,
    ).toBe(
      'Your CI setup can lead to default branch failures. Enable this to automatically fix broken builds.',
    );
    expect(
      result.find(
        ({ candidate }) => candidate.id === 'built-in.dependabot-triage',
      )?.explanation,
    ).toBe(
      'Your repos seem to have Dependabot alerts, and Roomote can handle those for you.',
    );
    expect(
      result.find(({ candidate }) => candidate.id === 'built-in.codeql-triage')
        ?.explanation,
    ).toBe(
      'Your repos seem to have CodeQL alerts, and Roomote can handle those for you.',
    );
  });

  it('always includes the baseline workflows after complete collection', () => {
    const result = scoreAutomationRecommendations(
      {
        ...signals,
        partial: false,
        mergedPrs30d: 0,
        openPrs: 0,
        conflicts: 0,
        ciFailures30d: 0,
        dependabotAlerts: 0,
        codeqlAlerts: 0,
        dependencyManifests: 0,
        docs: 0,
      },
      { reportProvider: 'slack' },
    );

    expect(result.map(({ candidate }) => candidate.id)).toEqual(
      expect.arrayContaining([
        'built-in.review-code',
        'built-in.ci-failure-triage',
        'built-in.resolve-pr-conflicts',
      ]),
    );
  });

  it('keeps baseline workflows in the result when other signals rank higher', () => {
    const result = scoreAutomationRecommendations(
      {
        ...signals,
        mergedPrs30d: 20,
        openPrs: 20,
        conflicts: 20,
        ciFailures30d: 20,
        dependabotAlerts: 20,
        codeqlAlerts: 20,
        dependencyManifests: 20,
      },
      { reportProvider: 'slack' },
    );

    expect(result.map(({ candidate }) => candidate.id)).toEqual(
      expect.arrayContaining([
        'built-in.review-code',
        'built-in.ci-failure-triage',
        'built-in.resolve-pr-conflicts',
      ]),
    );
  });
});

describe('recommendation delivery', () => {
  it('recommends only native review and conflict resolution without communications', () => {
    for (const options of [{}, { reportProvider: null }]) {
      expect(
        scoreAutomationRecommendations(signals, options).map(
          ({ candidate }) => candidate.id,
        ),
      ).toEqual(['built-in.review-code', 'built-in.resolve-pr-conflicts']);
    }
  });

  it.each(['gitlab', 'gitea', 'ado', 'bitbucket'] as const)(
    'does not recommend GitHub-only alerts for %s',
    (provider) => {
      const catalog = AUTOMATION_RECOMMENDATION_CATALOG.filter(({ id }) =>
        ['built-in.dependabot-triage', 'built-in.codeql-triage'].includes(id),
      );
      expect(
        scoreAutomationRecommendations(
          { ...signals, sourceControlProviders: [provider] },
          { catalog, reportProvider: 'slack' },
        ),
      ).toEqual([]);
      expect(
        scoreAutomationRecommendations(signals, {
          catalog,
          reportProvider: 'slack',
        }),
      ).toHaveLength(2);
    },
  );

  it.each(['slack', 'discord', 'teams', 'telegram'] as const)(
    'makes reports eligible with a configured %s destination',
    (provider) => {
      const catalog = AUTOMATION_RECOMMENDATION_CATALOG.filter(
        ({ outcome }) => outcome === 'report',
      );
      expect(catalog.map(({ id }) => id)).toEqual([
        'built-in.summarize-merged-prs',
        'built-in.weekly-manager-stats',
        'cookbook.scheduled-housekeeping',
      ]);
      for (const candidate of catalog) {
        expect(candidate.requiresReportDestination).toBe(true);
        expect(
          isAutomationRecommendationDeliveryEligible(candidate, null),
        ).toBe(false);
        expect(
          isAutomationRecommendationDeliveryEligible(candidate, provider),
        ).toBe(true);
      }
      expect(
        scoreAutomationRecommendations(signals, {
          catalog,
          reportProvider: provider,
        }),
      ).toHaveLength(3);
    },
  );
});

describe('catalog', () => {
  it.each([
    ['built-in.summarize-merged-prs', 'announcer'],
    ['built-in.weekly-manager-stats', 'manager_stats'],
  ])('maps %s to its weekly built-in', (id, automationKey) => {
    expect(
      AUTOMATION_RECOMMENDATION_CATALOG.find(
        (candidate) => candidate.id === id,
      ),
    ).toMatchObject({
      source: 'built_in',
      automationKey,
      defaultScheduleMode: 'weekly',
      outcome: 'report',
      requiresReportDestination: true,
    });
  });
  it('maps every curated slug to an existing recipe and matching frontmatter', () => {
    for (const candidate of AUTOMATION_RECOMMENDATION_CATALOG) {
      if (candidate.source !== 'cookbook') continue;
      const recipePath = `apps/docs/cookbook/${candidate.cookbookSlug}.mdx`;
      const path = [
        resolve(process.cwd(), '../../', recipePath),
        resolve(process.cwd(), recipePath),
      ].find((candidatePath) => existsSync(candidatePath));
      expect(path).toBeDefined();
      const frontmatterTitle = readFileSync(path!, 'utf8').match(
        /^title:\s*(.+)$/m,
      )?.[1];
      expect(frontmatterTitle).toBe(candidate.title);
    }
  });
});
