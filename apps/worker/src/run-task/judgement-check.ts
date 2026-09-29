import { check } from '@roo-code/judgement';

import { buildWorkerHeaders, createClient } from '@roomote/sdk/client';

/** Use the task's scoped API credential, never the launcher's environment. */
export async function checkRepositoryJudgement(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const runId = Number(env.ROOMOTE_TASK_RUN_ID);
  const url = env.ROOMOTE_PLATFORM_API_URL;
  const token = env.ROOMOTE_CLOUD_TOKEN;
  const client =
    url && token && Number.isSafeInteger(runId) && runId > 0
      ? createClient({
          url,
          headers: () =>
            buildWorkerHeaders({
              AUTH_TOKEN: token,
              ROOMOTE_AUTH_BYPASS_VALUE: env.ROOMOTE_AUTH_BYPASS_VALUE,
              ROOMOTE_AUTH_BYPASS_HEADER_NAME:
                env.ROOMOTE_AUTH_BYPASS_HEADER_NAME,
            }),
        })
      : null;
  return check({
    cwd,
    env,
    hook: true,
    deadlineMs: 3000,
    // Backend selection can change during a run. Do not reuse judgments without
    // an immutable backend revision; the standalone fixed-model CLI caches them.
    cache: false,
    evaluate: async (request, signal) => {
      if (!client)
        throw new Error('Judgement requires a task runtime credential');
      const result = await client.taskRuns.evaluateRepositoryJudgement.mutate(
        { runId, request },
        { signal },
      );
      if (result.kind !== 'answered')
        throw new Error('Judgement backend unavailable');
      return result.answer;
    },
  });
}
