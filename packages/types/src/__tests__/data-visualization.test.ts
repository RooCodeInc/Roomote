import { describe, expect, it } from 'vitest';

import {
  dataVisualizationInputSchema,
  dataVisualizationInputsSchema,
} from '../data-visualization';

const lineChart = {
  title: 'Weekly sales',
  block_id: 'weekly-sales',
  chart: {
    type: 'line' as const,
    series: [
      {
        name: 'Online',
        data: [
          { label: 'Week 1', value: 12 },
          { label: 'Week 2', value: -4 },
        ],
      },
    ],
    axis_config: {
      categories: ['Week 1', 'Week 2'],
      x_label: 'Week',
      y_label: 'Sales',
    },
  },
};

describe('data visualization schemas', () => {
  it('accepts documented pie and cartesian chart payloads', () => {
    expect(dataVisualizationInputSchema.safeParse(lineChart).success).toBe(
      true,
    );
    expect(
      dataVisualizationInputSchema.safeParse({
        title: 'Traffic sources',
        chart: {
          type: 'pie',
          segments: [
            { label: 'Search', value: 65 },
            { label: 'Direct', value: 35 },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      'zero-value pie segment',
      {
        title: 'Traffic',
        chart: { type: 'pie', segments: [{ label: 'Search', value: 0 }] },
      },
    ],
    ['overlong title', { ...lineChart, title: 'x'.repeat(51) }],
    [
      'duplicate series names',
      {
        ...lineChart,
        chart: {
          ...lineChart.chart,
          series: [lineChart.chart.series[0], lineChart.chart.series[0]],
        },
      },
    ],
    [
      'duplicate categories',
      {
        ...lineChart,
        chart: {
          ...lineChart.chart,
          axis_config: { categories: ['Week 1', 'Week 1'] },
        },
      },
    ],
    [
      'missing category point',
      {
        ...lineChart,
        chart: {
          ...lineChart.chart,
          series: [
            {
              name: 'Online',
              data: [{ label: 'Week 1', value: 12 }],
            },
          ],
        },
      },
    ],
    [
      'unknown category point',
      {
        ...lineChart,
        chart: {
          ...lineChart.chart,
          series: [
            {
              name: 'Online',
              data: [
                { label: 'Week 1', value: 12 },
                { label: 'Week 3', value: 4 },
              ],
            },
          ],
        },
      },
    ],
  ])('rejects %s', (_name, input) => {
    expect(dataVisualizationInputSchema.safeParse(input).success).toBe(false);
  });

  it('enforces the per-message chart count and unique block IDs', () => {
    expect(
      dataVisualizationInputsSchema.safeParse([
        lineChart,
        lineChart,
        { ...lineChart, block_id: 'third' },
      ]).success,
    ).toBe(false);
    expect(
      dataVisualizationInputsSchema.safeParse([lineChart, lineChart]).success,
    ).toBe(false);
  });
});
