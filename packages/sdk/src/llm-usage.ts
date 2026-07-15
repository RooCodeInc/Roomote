import { client, type AppRouterInput } from './client';

export type RecordLlmUsageInput = AppRouterInput['llmUsage']['record'];

export const record = (options: RecordLlmUsageInput) =>
  client.llmUsage.record.mutate(options);
