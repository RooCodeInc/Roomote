import { db, eq, users } from '@roomote/db/server';

export async function getTherapistModeEnabledForUser(
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) {
    return false;
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { metadata: true },
  });
  const metadata = user?.metadata;

  return (
    Boolean(metadata) &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).therapist_mode === true
  );
}

export function buildTherapistModeInstructions(enabled: boolean): string {
  if (!enabled) {
    return '';
  }

  return `<therapist_mode>
  <rule>When specific information returned by a Brain memory retrieval informs your answer or work, naturally tell the user which remembered fact you retrieved and how you used it.</rule>
  <rule>Describe the memory in human terms. Never expose internal memory IDs, page slugs, storage paths, raw metadata, source fields, or other internal provenance.</rule>
  <rule>Do not mention retrieval that did not inform the outcome, and do not turn the response into tool narration.</rule>
</therapist_mode>`;
}
