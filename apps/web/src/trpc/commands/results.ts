import {
  and,
  automationResults,
  count,
  db,
  desc,
  eq,
  isNull,
  or,
  sql,
} from '@roomote/db/server';
import {
  type BackgroundAutomationKey,
  type AutomationResultKind,
  type AutomationResultPriority,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { getPersonalPreferencesCommand } from './preferences';

export type ResultInboxItem = {
  id: string;
  kind: AutomationResultKind;
  automationName: string;
  title: string | null;
  content: string;
  priority: AutomationResultPriority;
  createdAt: Date;
  automationKey: BackgroundAutomationKey | null;
};

async function assertResultsEnabled(auth: UserAuthSuccess) {
  if (!(await getPersonalPreferencesCommand(auth)).resultsPageEnabled) {
    throw new Error('Results is not enabled.');
  }
}

const visibleResult = (userId: string) =>
  or(isNull(automationResults.userId), eq(automationResults.userId, userId))!;
const unreadResult = (userId: string) =>
  and(
    visibleResult(userId),
    isNull(automationResults.acceptedAt),
    isNull(automationResults.ignoredAt),
  )!;

export async function listResultsCommand(
  auth: UserAuthSuccess,
): Promise<ResultInboxItem[]> {
  await assertResultsEnabled(auth);
  return db
    .select({
      id: automationResults.id,
      kind: automationResults.kind,
      automationKey: automationResults.automationKey,
      automationName: automationResults.automationName,
      title: automationResults.title,
      content: automationResults.content,
      priority: automationResults.priority,
      createdAt: automationResults.createdAt,
    })
    .from(automationResults)
    .where(unreadResult(auth.userId))
    .orderBy(
      sql`case ${automationResults.priority} when 'critical' then 2 when 'high' then 1 else 0 end desc`,
      desc(automationResults.createdAt),
      desc(automationResults.id),
    )
    .limit(100);
}

export async function getUnreadResultCountCommand(auth: UserAuthSuccess) {
  if (!(await getPersonalPreferencesCommand(auth)).resultsPageEnabled) return 0;
  const [row] = await db
    .select({ count: count() })
    .from(automationResults)
    .where(unreadResult(auth.userId));
  return Number(row?.count ?? 0);
}

export async function actOnResultCommand(
  auth: UserAuthSuccess,
  input: {
    id: string;
    kind: AutomationResultKind;
    action: 'accept' | 'ignore';
  },
) {
  await assertResultsEnabled(auth);
  const now = new Date();
  const values =
    input.action === 'accept'
      ? { acceptedAt: now, ignoredAt: null, updatedAt: now }
      : { acceptedAt: null, ignoredAt: now, updatedAt: now };

  await db
    .update(automationResults)
    .set(values)
    .where(
      and(
        eq(automationResults.id, input.id),
        eq(automationResults.kind, input.kind),
        visibleResult(auth.userId),
      ),
    );

  return { success: true as const };
}

export async function clearResultsCommand(auth: UserAuthSuccess) {
  await assertResultsEnabled(auth);
  const now = new Date();
  await db
    .update(automationResults)
    .set({ ignoredAt: now, updatedAt: now })
    .where(unreadResult(auth.userId));
  return { success: true as const };
}
