import { getSessionPrReviews } from './session-pr-reviews';
import { RunStatus } from '@roomote/types';
import type { SessionReviewTask } from './session-task-panel-context';

const review = {
  url: 'https://github.com/acme/web/pull/42',
  repository: 'acme/web',
  number: 42,
  summary: 'Missing coverage',
  findingCount: 1,
  status: 'feedback',
};
const offer = {
  deliveryId: 'delivery-1',
  question: 'Resolve?',
  status: 'pending',
};
const message = {
  id: 'message-1',
  payload: { prReview: review, prReviewAction: offer },
};

it('keeps distinct repositories and hosts separate even for the same PR number', () => {
  expect(
    getSessionPrReviews(
      [
        message,
        {
          id: 'message-2',
          payload: {
            prReview: {
              ...review,
              url: 'https://gitlab.example/other/project/-/merge_requests/42',
            },
          },
        },
      ],
      [],
    ),
  ).toHaveLength(2);
});

it('does not resurrect an old action after a newer dismissal or approval', () => {
  const dismissed = {
    id: 'message-2',
    payload: {
      prReview: review,
      prReviewAction: { ...offer, status: 'dismissed' },
    },
  };
  expect(getSessionPrReviews([message, dismissed], [])).toEqual([]);
  const approved = {
    id: 'message-3',
    payload: { prReview: { ...review, status: 'approved', findingCount: 0 } },
  };
  const [latest] = getSessionPrReviews([message, dismissed, approved], []);
  expect(latest?.offer).toBeNull();
  expect(latest?.review?.status).toBe('approved');
});

it('keeps legacy action offers usable without inventing PR context', () => {
  const [latest] = getSessionPrReviews(
    [{ id: 'legacy', payload: { prReviewAction: offer } }],
    [],
  );
  expect(latest?.review).toBeNull();
  expect(latest?.offer).toEqual(offer);
});

it('shows an active review and prefers its task over older completed reviews', () => {
  const active: SessionReviewTask = {
    taskId: 'active',
    workflow: 'pr_review',
    latestRun: { status: RunStatus.Running },
    pullRequests: [
      { url: review.url, number: 42, repository: 'acme/web', status: 'open' },
    ],
  };
  const completed: SessionReviewTask = {
    ...active,
    taskId: 'old',
    latestRun: { status: RunStatus.Completed },
  };
  const [latest] = getSessionPrReviews([message], [active, completed]);
  expect(latest?.reviewing).toBe(true);
  expect(latest?.reviewTaskId).toBe('active');
  expect(getSessionPrReviews([], [active])[0]?.reviewing).toBe(true);
  expect(getSessionPrReviews([], [completed])).toEqual([]);
});

it('retires the fix action when the PR has merged', () => {
  const [latest] = getSessionPrReviews(
    [message],
    [
      {
        taskId: 'review',
        workflow: 'pr_review',
        latestRun: { status: RunStatus.Completed },
        pullRequests: [
          {
            url: review.url,
            number: 42,
            repository: 'acme/web',
            status: 'merged',
          },
        ],
      },
    ],
  );
  expect(latest?.offer).toBeNull();
  expect(latest?.review?.status).toBe('merged');
});
