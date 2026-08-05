import { render, screen } from '@testing-library/react';

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

it('renders the task tabs without the feedback prompt', () => {
  render(<BottomSheetTabs />);

  expect(
    screen.getByRole('button', { name: 'Recent Tasks' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Recent PRs' }),
  ).toBeInTheDocument();
  expect(screen.queryByText('Feedback, please!')).not.toBeInTheDocument();
});
