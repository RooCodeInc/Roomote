import { Env } from '@roomote/env';
import {
  db,
  ensureSessionForTask,
  getSessionForTask,
} from '@roomote/db/server';

type UtmParams = {
  source: string;
  medium?: string;
  campaign: string;
};

function buildAppUrl(
  path: string,
  { source, medium = 'link', campaign }: UtmParams,
): string {
  return `${Env.R_APP_URL}${path}?utm_source=${source}&utm_medium=${medium}&utm_campaign=${encodeURIComponent(campaign)}`;
}

export function getTaskUrl({
  taskId,
  utm: { source, medium = 'link', campaign },
}: {
  taskId: string;
  utm: UtmParams;
}): string {
  return buildAppUrl(`/task/${taskId}`, { source, medium, campaign });
}

/** Resolve the persisted origin, including direct and hidden automation work. */
export async function getTaskSessionUrl({
  taskId,
  fastConversationId,
  utm,
}: {
  taskId: string;
  fastConversationId?: string;
  utm: UtmParams;
}): Promise<string> {
  const session =
    (await getSessionForTask(db, taskId)) ??
    (await db.transaction((tx) =>
      ensureSessionForTask(tx, { taskId, fastConversationId }),
    ));
  // Visibility controls discovery, not direct-link access. Session privacy
  // remains enforced by the detail route, including automation-owned sessions.
  return buildAppUrl(`/sessions/${session.id}`, utm);
}
