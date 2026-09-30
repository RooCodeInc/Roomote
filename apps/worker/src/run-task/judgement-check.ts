import { check } from '@roo-code/judgement';

/** Use the worker's local proxy without requiring a task or provider key. */
export async function checkRepositoryJudgement(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  const failures = new Set<string>();
  const report = await check({
    cwd,
    env,
    hook: true,
    deadlineMs: 3000,
    cache: false,
    evaluate: async (request, signal) => {
      const endpoint = env.R_JUDGEMENT_GATEWAY_URL;
      if (!endpoint) {
        failures.add('Roomote Judgement proxy is unavailable for this task.');
        throw new Error('Missing proxy');
      }
      const url = new URL(endpoint);
      if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        url.pathname !== '/judge' ||
        url.username ||
        url.password
      )
        throw new Error('Invalid local proxy');
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal,
          redirect: 'error',
        });
        if (!response.ok) {
          failures.add(
            response.status === 503
              ? 'Configure a supported Jev provider in Roomote Settings > Models.'
              : 'Roomote Judgement evaluation failed or timed out.',
          );
          await response.body?.cancel();
          throw new Error('Evaluation unavailable');
        }
        return await response.json();
      } catch {
        failures.add(
          'Could not complete a judgment through the Roomote proxy.',
        );
        throw new Error('Proxy evaluation failed');
      }
    },
  });
  report.messages.push(...failures);
  return report;
}
