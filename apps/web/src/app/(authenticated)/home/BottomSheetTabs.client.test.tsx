import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('./PullRequestsList', () => ({
  PullRequestsList: () => <div>Pull requests</div>,
}));

vi.mock('./RecentTasksList', () => ({
  RecentTasksList: () => <div>Recent tasks</div>,
}));

import { BottomSheetTabs } from './BottomSheetTabs';

beforeEach(() => {
  window.localStorage.clear();
});

it('opens the feedback dialog with scheduling and email options', async () => {
  render(<BottomSheetTabs />);

  fireEvent.click(
    await screen.findByRole('button', { name: 'your thoughts on Roomote' }),
  );

  expect(
    screen.getByRole('dialog', { name: 'Roomote Feedback' }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("We'd love to hear about your experience so far."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('link', { name: 'Book time with the founders' }),
  ).toHaveAttribute(
    'href',
    'https://calendly.com/d/ctx9-f7q-6vr/roomote-feedback',
  );
  expect(screen.getByRole('link', { name: 'Write us' })).toHaveAttribute(
    'href',
    'mailto:help@roomote.dev?subject=My%20thoughts%20on%20Roomote%20so%20far',
  );
});

it('persists dismissal of the feedback prompt', async () => {
  const { unmount } = render(<BottomSheetTabs />);

  fireEvent.click(
    await screen.findByRole('button', { name: 'Dismiss feedback prompt' }),
  );

  expect(window.localStorage.getItem('roomote-home-feedback-dismissed')).toBe(
    '1',
  );
  expect(
    screen.queryByRole('button', { name: 'your thoughts on Roomote' }),
  ).not.toBeInTheDocument();

  unmount();
  render(<BottomSheetTabs />);

  expect(
    screen.queryByRole('button', { name: 'your thoughts on Roomote' }),
  ).not.toBeInTheDocument();
});
