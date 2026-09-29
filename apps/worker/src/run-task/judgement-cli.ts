import { exitCode, formatReport } from '@roocodeinc/judgement';

import { checkRepositoryJudgement } from './judgement-check';

try {
  const report = await checkRepositoryJudgement();
  console.error(formatReport(report));
  process.exitCode = exitCode(report, { hook: true });
} catch {
  console.error(
    'judgement: incomplete; a full check is required before merge.',
  );
  process.exitCode = 0;
}
