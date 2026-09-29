import { runCli, ConfigurationError } from '@roo-code/judgement';
import {
  checkLocalRepositoryJudgement,
  evaluateLocalRepositoryJudgement,
} from './judgement-local';

// The host supplies inference; command parsing, fixtures, and reports belong to Judgement.
void runCli(process.argv.slice(2), {
  check: checkLocalRepositoryJudgement,
  evaluate: evaluateLocalRepositoryJudgement,
})
  // The deployment settings resolver opens database pools; this CLI is one-shot.
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('judgement: interrupted.');
      process.exit(130);
    }
    if (error instanceof ConfigurationError) {
      console.error(`judgement: ${error.message}`);
      process.exit(2);
    }
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      console.error(
        'judgement: output already exists. Choose a new file; capture never overwrites.',
      );
      process.exit(2);
    }
    console.error(
      'judgement: failed to start. Check arguments, .env.local, and local Roomote configuration. Use pnpm judgement --help for command syntax.',
    );
    process.exit(2);
  });
