import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  AnalyticsFilterBar,
  normalizeSelectedAnalyticsFilterValues,
} from './AnalyticsFilterBar';

const FILTER_OPTIONS = {
  user: [{ value: 'user:user-123', label: 'Analytics Tester' }],
};

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

describe('AnalyticsFilterBar', () => {
  it('keeps chart granularity out of the mobile filters drawer', () => {
    render(
      createElement(AnalyticsFilterBar, {
        object: 'tasks',
        filters: {},
        filterOptions: FILTER_OPTIONS,
        onFilterChange: vi.fn(),
        onResetFilters: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));

    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.getAllByText('Filters')).toHaveLength(1);
    expect(
      screen.queryByRole('combobox', { name: 'Time range' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('combobox', { name: 'Chart granularity' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('By Day')).not.toBeInTheDocument();
  });
});
