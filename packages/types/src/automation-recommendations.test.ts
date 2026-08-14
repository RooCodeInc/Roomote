import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AUTOMATION_RECOMMENDATION_CATALOG,
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
  it('is deterministic and ranks signal-backed candidates first', () => {
    const first = scoreAutomationRecommendations(signals);
    const second = scoreAutomationRecommendations(signals);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.length).toBeLessThanOrEqual(6);
    expect(first[0]?.candidate.id).toBe('built-in.code-quality-auditor');
    expect(first.every(({ explanation }) => explanation.length > 0)).toBe(true);
  });

  it('removes enabled candidates and caps categories', () => {
    const result = scoreAutomationRecommendations(signals, {
      enabledCandidateIds: new Set(['built-in.resolve-pr-conflicts']),
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

  it('supports sparse data with honest fallback copy', () => {
    const result = scoreAutomationRecommendations({
      ...signals,
      mergedPrs30d: 0,
      openPrs: 0,
      conflicts: 0,
      ciFailures30d: 0,
      dependabotAlerts: 0,
      dependencyManifests: 0,
      docs: 0,
    });

    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.length).toBeLessThanOrEqual(6);
    expect(
      result.every(
        ({ explanation }) =>
          explanation.includes('connected') ||
          explanation.includes('recurring'),
      ),
    ).toBe(true);
  });
});

describe('catalog', () => {
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
