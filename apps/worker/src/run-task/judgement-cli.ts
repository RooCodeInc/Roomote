import { ConfigurationError, runCli } from '@roo-code/judgement';
import {
  checkRepositoryJudgement,
  evaluateTaskJudgement,
} from './judgement-check';

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    check: (options = {}) =>
      checkRepositoryJudgement(process.env, options.cwd, options),
    evaluate: evaluateTaskJudgement,
  });
} catch (error) {
  if (error instanceof Error && error.name === 'AbortError') {
    console.error('judgement: interrupted.');
    process.exitCode = 130;
  } else {
    console.error(
      error instanceof ConfigurationError
        ? `judgement: ${error.message}`
        : 'judgement: command failed. Check arguments, files, and the Roomote inference configuration.',
    );
    process.exitCode = 2;
  }
}
