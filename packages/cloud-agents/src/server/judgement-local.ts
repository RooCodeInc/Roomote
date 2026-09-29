import {
  check,
  type CheckOptions,
  type JudgeRequest,
} from '@roo-code/judgement';

/** Developer checks and example suites share Roomote's inference configuration. */
export async function evaluateLocalRepositoryJudgement(
  request: JudgeRequest,
  signal: AbortSignal,
) {
  let answer;
  try {
    // Dry runs and repositories with no applicable rules need no database.
    const { evaluateRepositoryJudgement } = await import('./judge-file');
    signal.throwIfAborted();
    answer = await evaluateRepositoryJudgement(request);
    signal.throwIfAborted();
  } catch {
    throw new Error(
      'Roomote inference could not complete the check. Verify the local database, deployment settings, and provider access.',
    );
  }
  if (!answer) {
    throw new Error(
      'No supported Judgement backend is configured. Select Jev in Roomote Settings > Models and configure its provider credentials. R_JUDGMENT_MODEL overrides that selection.',
    );
  }
  return answer;
}

export async function checkLocalRepositoryJudgement(options: CheckOptions) {
  const failures = new Set<string>();
  const report = await check({
    ...options,
    cache: false,
    evaluate: async (request, signal) => {
      try {
        return await evaluateLocalRepositoryJudgement(request, signal);
      } catch (error) {
        // The shared adapter only throws the safe configuration messages above.
        failures.add((error as Error).message);
        throw new Error('Roomote inference unavailable');
      }
    },
  });
  report.messages.push(...failures);
  return report;
}
