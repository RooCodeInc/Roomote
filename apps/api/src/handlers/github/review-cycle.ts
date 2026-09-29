import { createHash } from 'node:crypto';

export function buildGithubPrReviewCycleId(input: {
  repository: string;
  prNumber: number;
  headSha: string;
  admissionId?: string;
}): string {
  const identity = [
    'github-pr-review-cycle',
    input.repository.toLowerCase(),
    String(input.prNumber),
    input.headSha,
    input.admissionId ?? `head:${input.headSha}`,
  ].join(':');

  return `github-review-cycle:${createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, 32)}`;
}
