import { client, type AppRouterInput } from './client';

export type RecordLlmUsageInput = Omit<
  AppRouterInput['llmUsage']['record'],
  'source'
> & {
  source: string;
};

export const record = (options: RecordLlmUsageInput) =>
  client.llmUsage.record.mutate(options);
