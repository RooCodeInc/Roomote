import { z } from 'zod';

export const MEMORY_SAVED_EVENT_TEXT = 'Saved to memory' as const;

export const memorySavedEventPayloadSchema = z.object({
  memories: z.array(z.string().trim().min(1)).min(1),
});

export type MemorySavedEventPayload = z.infer<
  typeof memorySavedEventPayloadSchema
>;

export function parseMemorySavedEventPayload(
  payload: unknown,
): MemorySavedEventPayload | null {
  const parsed = memorySavedEventPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
