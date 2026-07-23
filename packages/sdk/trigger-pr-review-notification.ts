/**
 * Local demo trigger: links a task to a real PR and enqueues a PR review
 * notification for a GHAS inline comment. Debounce is 60s, so the bullmq job
 * fires a minute later. Untracked; delete after the demo.
 *
 * Usage:
 *   pnpm exec dotenvx run -f ../../.env.local -- pnpm exec tsx trigger-pr-review-notification.ts <taskId>
 */
import { db, taskPullRequests } from '@roomote/db/server';

import { enqueuePrReviewNotification } from './src/server';

const taskId = process.argv[2];

if (!taskId) {
  console.error('Usage: tsx trigger-pr-review-notification.ts <taskId>');
  process.exit(1);
}

const repository = 'RooCodeInc/Roomote';
const prNumber = Number(process.argv[3] ?? 690);
const prUrl = `https://github.com/RooCodeInc/Roomote/pull/${prNumber}`;

async function main() {
  await db
    .insert(taskPullRequests)
    .values({
      taskId,
      sourceControlProvider: 'github',
      repository,
      prNumber,
      prUrl,
      status: 'open',
    })
    .onConflictDoNothing();

  const result = await enqueuePrReviewNotification({
    repository,
    prNumber,
    prUrl,
    sourceControlProvider: 'github',
    event: {
      kind: 'review_comment',
      authorLogin: 'github-advanced-security[bot]',
      url: `https://github.com/RooCodeInc/Roomote/pull/${prNumber}#discussion_r3632830817`,
    },
  });

  console.log('enqueue result:', JSON.stringify(result));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
