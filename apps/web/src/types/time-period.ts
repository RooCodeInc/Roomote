import { z } from 'zod';

const timePeriods = [1, 7, 30, 90] as const;

export const timePeriodFilterSchema = z.union([
  z.literal(timePeriods[0]),
  z.literal(timePeriods[1]),
  z.literal(timePeriods[2]),
  z.literal(timePeriods[3]),
  z.literal('all'),
]);

export type TimePeriodFilter = z.infer<typeof timePeriodFilterSchema>;

/**
 * Parse a time period search param string into a validated TimePeriodFilter.
 * Returns `defaultValue` when the param is missing or invalid.
 */
export function parseTimePeriodParam(
  param: string | null,
  defaultValue: TimePeriodFilter,
): TimePeriodFilter {
  if (!param) {
    return defaultValue;
  }

  const result = timePeriodFilterSchema.safeParse(
    param === 'all' ? 'all' : parseInt(param, 10),
  );

  return result.success ? result.data : defaultValue;
}
