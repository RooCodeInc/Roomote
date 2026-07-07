import { describe, expect, it } from 'vitest';

import { normalizeSelectedAnalyticsFilterValues } from './AnalyticsFilterBar';

describe('normalizeSelectedAnalyticsFilterValues', () => {
  it('maps legacy label-based selections to canonical option values', () => {
    expect(
      normalizeSelectedAnalyticsFilterValues(
        ['Analytics Tester'],
        [
          {
            value: 'user:user-123',
            label: 'Analytics Tester',
          },
        ],
      ),
    ).toEqual(['user:user-123']);
  });

  it('maps duplicate legacy labels to every matching canonical option value', () => {
    expect(
      normalizeSelectedAnalyticsFilterValues(
        ['Alex'],
        [
          {
            value: 'user:user-123',
            label: 'Alex',
          },
          {
            value: 'user:user-456',
            label: 'Alex',
          },
        ],
      ),
    ).toEqual(['user:user-123', 'user:user-456']);
  });

  it('preserves canonical values and unknown values', () => {
    expect(
      normalizeSelectedAnalyticsFilterValues(
        ['user:user-123', 'unknown-legacy-filter'],
        [
          {
            value: 'user:user-123',
            label: 'Analytics Tester',
          },
        ],
      ),
    ).toEqual(['user:user-123', 'unknown-legacy-filter']);
  });

  it('prefers exact canonical values over duplicate label expansion', () => {
    expect(
      normalizeSelectedAnalyticsFilterValues(
        ['user:user-123'],
        [
          {
            value: 'user:user-123',
            label: 'Alex',
          },
          {
            value: 'user:user-456',
            label: 'Alex',
          },
        ],
      ),
    ).toEqual(['user:user-123']);
  });
});
