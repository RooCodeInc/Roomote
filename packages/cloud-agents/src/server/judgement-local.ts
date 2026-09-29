import { check, type CheckOptions } from '@roo-code/judgement';

/** Developer checks share the API's deployment settings and credential resolver. */
export async function checkLocalRepositoryJudgement(options: CheckOptions) {
  const failures = new Set<string>();
  const report = await check({
    ...options,
    cache: false,
    evaluate: async (request, signal) => {
      try {
        // Dry runs and repositories with no applicable rules need no database.
        const { evaluateRepositoryJudgement } = await import('./judge-file');
        signal.throwIfAborted();
        const answer = await evaluateRepositoryJudgement(request);
        signal.throwIfAborted();
        if (!answer) {
          failures.add(
            'No supported Judgement backend is configured. Select Jev in Roomote Settings > Models and configure its provider credentials. R_JUDGMENT_MODEL overrides that selection.',
          );
          throw new Error('Backend unavailable');
        }
        return answer;
      } catch {
        if (!failures.size)
          failures.add(
            'Roomote inference could not complete the check. Verify the local database, deployment settings, and provider access.',
          );
        throw new Error('Roomote inference unavailable');
      }
    },
  });
  report.messages.push(...failures);
  return report;
}
