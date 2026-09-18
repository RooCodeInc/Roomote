import { z } from 'zod';

const chartLabelSchema = z.string().trim().min(1).max(20);
const chartTitleSchema = z.string().trim().min(1).max(50);

export const dataVisualizationSegmentSchema = z.object({
  label: chartLabelSchema,
  value: z.number().finite().gt(0),
});

export const dataVisualizationPointSchema = z.object({
  label: chartLabelSchema,
  value: z.number().finite(),
});

export const dataVisualizationSeriesSchema = z.object({
  name: chartLabelSchema,
  data: z.array(dataVisualizationPointSchema).min(1).max(20),
});

export const dataVisualizationAxisConfigSchema = z.object({
  categories: z.array(chartLabelSchema).min(1).max(20),
  x_label: chartTitleSchema.optional(),
  y_label: chartTitleSchema.optional(),
});

const dataVisualizationPieChartSchema = z.object({
  type: z.literal('pie'),
  segments: z.array(dataVisualizationSegmentSchema).min(1).max(12),
});

const dataVisualizationCartesianChartSchema = z
  .object({
    type: z.enum(['bar', 'area', 'line']),
    series: z.array(dataVisualizationSeriesSchema).min(1).max(12),
    axis_config: dataVisualizationAxisConfigSchema,
  })
  .superRefine((chart, ctx) => {
    const categories = chart.axis_config.categories;
    if (new Set(categories).size !== categories.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['axis_config', 'categories'],
        message: 'Category labels must be unique.',
      });
    }

    const seriesNames = chart.series.map((series) => series.name);
    if (new Set(seriesNames).size !== seriesNames.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['series'],
        message: 'Series names must be unique.',
      });
    }

    const categorySet = new Set(categories);
    for (const [seriesIndex, series] of chart.series.entries()) {
      const labels = series.data.map((point) => point.label);
      if (
        labels.length !== categories.length ||
        new Set(labels).size !== labels.length ||
        labels.some((label) => !categorySet.has(label))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['series', seriesIndex, 'data'],
          message:
            'Series data must contain exactly one point for every axis category.',
        });
      }
    }
  });

export const dataVisualizationChartSchema = z.union([
  dataVisualizationPieChartSchema,
  dataVisualizationCartesianChartSchema,
]);

export const dataVisualizationInputSchema = z.object({
  title: chartTitleSchema,
  chart: dataVisualizationChartSchema,
  block_id: z.string().trim().min(1).max(255).optional(),
});

export const dataVisualizationInputsSchema = z
  .array(dataVisualizationInputSchema)
  .max(2)
  .superRefine((charts, ctx) => {
    const blockIds = charts.flatMap((chart) =>
      chart.block_id ? [chart.block_id] : [],
    );
    if (new Set(blockIds).size !== blockIds.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Chart block IDs must be unique within a message.',
      });
    }
  });

export const dataVisualizationBlockSchema = z.object({
  type: z.literal('data_visualization'),
  ...dataVisualizationInputSchema.shape,
});

export type DataVisualizationInput = z.infer<
  typeof dataVisualizationInputSchema
>;
export type DataVisualizationBlock = z.infer<
  typeof dataVisualizationBlockSchema
>;

export function buildDataVisualizationBlocks(
  charts: DataVisualizationInput[] | undefined,
): DataVisualizationBlock[] {
  return (charts ?? []).slice(0, 2).map((chart) => ({
    type: 'data_visualization',
    ...chart,
  }));
}

export function getDataVisualizationBlocks(
  blocks: unknown[] | null | undefined,
): DataVisualizationBlock[] {
  return (blocks ?? [])
    .flatMap((block) => {
      const parsed = dataVisualizationBlockSchema.safeParse(block);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, 2);
}
