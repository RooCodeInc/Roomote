import { z } from 'zod';
export { HAS_PULL_REQUEST_FILTER_VALUE } from '@roomote/types';

/**
 * FilterType
 */

export const filterTypes = [
  'userId',
  'category',
  'environmentId',
  'repositoryName',
  'pullRequest', // owner/repo#prNumber or __has_pr__
  'model',
  'taskType',
] as const;

export type FilterType = (typeof filterTypes)[number];

/**
 * Filter
 */

export const filterSchema = z.object({
  type: z.enum(filterTypes),
  value: z.string(),
  label: z.string(),
});

export type Filter = z.infer<typeof filterSchema>;
