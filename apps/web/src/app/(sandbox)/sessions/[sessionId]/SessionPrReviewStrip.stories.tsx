import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { SessionPrReviewStrip } from './SessionPrReviewStrip';
import type { SessionReview } from './session-pr-reviews';

const pending: SessionReview = {
  key: 'pr-42',
  revision: 'feedback-1',
  review: {
    url: 'https://github.com/example/project/pull/42',
    repository: 'example/project',
    number: 42,
    summary:
      'The provider catalog is missing coverage for an additional route.',
    findingCount: 1,
    status: 'feedback',
  },
  offer: {
    deliveryId: 'delivery-1',
    question: 'Resolve the review feedback?',
    status: 'pending',
  },
};

const meta: Meta<typeof SessionPrReviewStrip> = {
  title: 'Sessions/Pinned PR review',
  component: SessionPrReviewStrip,
  parameters: { layout: 'centered' },
  args: {
    reviews: [pending],
    onAction: async (_deliveryId, choice) =>
      choice === 'dismiss'
        ? 'dismissed'
        : choice === 'auto'
          ? 'auto_resolved'
          : 'resolved',
  },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] w-[420px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl border border-border bg-background">
        <div className="border-b border-border px-4 py-4 text-sm font-medium">
          Update provider support
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 text-sm">
          <p>Add the missing model providers and open a PR.</p>
          <p>The implementation is complete in PR #42. Validation passed.</p>
          <p>I started a review of the changes.</p>
          {Array.from({ length: 8 }, (_, index) => (
            <p key={index} className="text-muted-foreground">
              Earlier conversation · {index + 1}
            </p>
          ))}
        </div>
        <Story />
        <div className="shrink-0 bg-card px-4 pb-4 pt-3">
          <textarea
            aria-label="Message agent"
            placeholder="Message agent"
            className="h-16 w-full resize-none bg-transparent text-sm outline-none"
          />
          <div className="text-xs text-muted-foreground">+ &nbsp; Model</div>
        </div>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;
export const Feedback: Story = {};
export const Reviewing: Story = {
  args: { reviews: [{ ...pending, reviewing: true }] },
};
export const Approved: Story = {
  args: {
    reviews: [
      {
        ...pending,
        offer: null,
        review: { ...pending.review!, status: 'approved', findingCount: 0 },
      },
    ],
  },
};
export const MultiplePullRequests: Story = {
  args: {
    reviews: [
      pending,
      {
        ...pending,
        key: 'pr-43',
        revision: 'feedback-2',
        review: {
          ...pending.review!,
          number: 43,
          url: 'https://github.com/example/project/pull/43',
        },
        offer: { ...pending.offer!, deliveryId: 'delivery-2' },
      },
    ],
  },
};
