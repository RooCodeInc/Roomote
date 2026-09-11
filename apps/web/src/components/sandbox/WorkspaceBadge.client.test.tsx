import { render, screen } from '@testing-library/react';
import { ALL_REPOSITORIES } from '@roomote/types';

vi.mock('@/hooks/environments', () => ({
  useEnvironment: () => ({ data: null }),
}));

import { WorkspaceBadge } from './WorkspaceBadge';

describe('WorkspaceBadge', () => {
  it('labels the all-repositories sentinel for people', () => {
    render(<WorkspaceBadge repo={ALL_REPOSITORIES} />);

    expect(screen.getByText('All repositories')).toBeInTheDocument();
    expect(screen.queryByText(ALL_REPOSITORIES)).not.toBeInTheDocument();
  });
});
