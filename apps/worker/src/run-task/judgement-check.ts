import {
  check,
  type CheckOptions,
  type JudgeRequest,
} from '@roo-code/judgement';

/** Task tools receive only the local endpoint; provider and run keys stay outside. */
export async function evaluateTaskJudgement(
  request: JudgeRequest,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
) {
  const endpoint = env.R_JUDGEMENT_GATEWAY_URL;
  if (!endpoint)
    throw new Error('Roomote Judgement proxy is unavailable for this task.');
  const url = new URL(endpoint);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/judge' ||
    url.username ||
    url.password
  )
    throw new Error('Invalid local Judgement proxy');
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 503)
        throw new Error(
          'Configure a supported Jev provider in Roomote Settings > Models.',
        );
      throw new Error('Roomote Judgement evaluation failed or timed out.');
    }
    return await response.json();
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof Error &&
      (error.message.startsWith('Configure a supported Jev') ||
        error.message === 'Roomote Judgement evaluation failed or timed out.')
    )
      throw error;
    throw new Error('Could not complete a judgment through the Roomote proxy.');
  }
}

/** Hook defaults are retained for managed callers; the shared CLI supplies its mode. */
export async function checkRepositoryJudgement(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  options: CheckOptions = {},
) {
  const failures = new Set<string>();
  const report = await check({
    hook: true,
    deadlineMs: 3000,
    ...options,
    cwd,
    env,
    cache: false,
    evaluate: async (request, signal) => {
      try {
        return await evaluateTaskJudgement(request, signal, env);
      } catch (error) {
        failures.add((error as Error).message);
        throw new Error('Roomote inference unavailable');
      }
    },
  });
  report.messages.push(...failures);
  return report;
}
