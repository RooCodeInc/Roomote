import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { CiFailureTriageRepositoryRoute } from '@roomote/types';

import { CiFailureTriageRepositoryRoutesEditor } from './CiFailureTriageRepositoryRoutesEditor';

vi.mock('@/hooks/source-control', () => ({
  useRepositories: () => ({
    data: [
      {
        id: 'repo-a',
        fullName: 'acme/api',
        sourceControlProvider: 'gitlab',
        host: 'gitlab.com',
      },
      {
        id: 'repo-b',
        fullName: 'acme/api',
        sourceControlProvider: 'gitlab',
        host: 'git.example.com',
      },
    ],
    isPending: false,
    isError: false,
  }),
}));

const initialRoutes: CiFailureTriageRepositoryRoute[] = [
  {
    repositoryIds: ['repo-a'],
    target: {
      provider: 'teams',
      targetKind: 'teams_channel',
      externalRef: 'team-a',
    },
  },
  {
    repositoryIds: ['repo-b'],
    target: {
      provider: 'telegram',
      targetKind: 'telegram_chat',
      externalRef: 'chat-b',
    },
  },
];

function Editor({
  initial = initialRoutes,
}: {
  initial?: CiFailureTriageRepositoryRoute[];
}) {
  const [routes, setRoutes] = useState<
    CiFailureTriageRepositoryRoute[] | undefined
  >(initial);
  return (
    <CiFailureTriageRepositoryRoutesEditor
      routes={routes}
      onChange={setRoutes}
      availableProviders={['slack', 'discord', 'teams', 'telegram']}
      slackOptions={[]}
      discordOptions={[]}
      globalDestination={<p>Shared destination</p>}
    />
  );
}

describe('CI repository group editor', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  it('shows provider/host identity, prevents overlaps, and keeps destinations separate', () => {
    render(<Editor />);
    const groups = screen.getAllByRole('group');
    expect(
      within(groups[0]!).getByRole('checkbox', {
        name: 'acme/api (gitlab | gitlab.com)',
      }),
    ).toBeChecked();
    expect(
      within(groups[0]!).queryByRole('checkbox', { name: /git.example.com/ }),
    ).not.toBeInTheDocument();
    expect(
      within(groups[1]!).getByRole('checkbox', {
        name: 'acme/api (gitlab | git.example.com)',
      }),
    ).toBeChecked();
    const destinations = screen.getAllByRole('textbox', {
      name: 'Destination channel',
    });
    fireEvent.change(destinations[0]!, { target: { value: 'new-team' } });
    expect(destinations[0]).toHaveValue('new-team');
    expect(destinations[1]).toHaveValue('chat-b');
  });

  it('removing every group leaves explicit empty scope, not the shared destination', () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove group 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove group 1' }));
    expect(
      screen.getByText(
        'No repositories selected. CI Failure Triage will not launch tasks.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Shared destination')).not.toBeInTheDocument();
  });

  it('switches explicitly between all repositories and selected groups', async () => {
    render(<Editor initial={[]} />);
    fireEvent.keyDown(
      screen.getByRole('combobox', { name: 'Repository scope' }),
      { key: 'ArrowDown' },
    );
    fireEvent.click(
      await screen.findByRole('option', { name: 'All repositories' }),
    );
    expect(screen.getByText('Shared destination')).toBeInTheDocument();
    fireEvent.keyDown(
      screen.getByRole('combobox', { name: 'Repository scope' }),
      { key: 'ArrowDown' },
    );
    fireEvent.click(
      await screen.findByRole('option', { name: 'Selected repository groups' }),
    );
    expect(
      screen.getByText(
        'No repositories selected. CI Failure Triage will not launch tasks.',
      ),
    ).toBeInTheDocument();
  });
});
