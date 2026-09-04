import { render, screen } from '@testing-library/react';

vi.mock('./PullRequestsList', () => ({
  PullRequestsList: () => <div>Pull requests</div>,
}));

vi.mock('./RecentSessionsList', () => ({
  RecentSessionsList: () => <div>Recent sessions</div>,
}));

import { BottomSheetTabs } from './BottomSheetTabs';

beforeEach(() => {
  window.localStorage.clear();
});

it('renders the home tabs without the feedback prompt', () => {
  render(<BottomSheetTabs />);

  expect(
    screen.getByRole('button', { name: 'Recent Sessions' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Recent PRs' }),
  ).toBeInTheDocument();
  expect(screen.queryByText('Feedback, please!')).not.toBeInTheDocument();
});
