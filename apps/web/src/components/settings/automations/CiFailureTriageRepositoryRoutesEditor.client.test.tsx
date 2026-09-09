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
      {
        id: 'repo-c',
        fullName: 'acme/api',
        sourceControlProvider: 'github',
        host: 'github.com',
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
  onSave = () => {},
}: {
  initial?: CiFailureTriageRepositoryRoute[];
  onSave?: (routes: CiFailureTriageRepositoryRoute[] | undefined) => void;
}) {
  const [routes, setRoutes] = useState<
    CiFailureTriageRepositoryRoute[] | undefined
  >(initial);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(routes);
      }}
    >
      <CiFailureTriageRepositoryRoutesEditor
        routes={routes}
        onChange={setRoutes}
        availableProviders={['slack', 'discord', 'teams', 'telegram']}
        slackOptions={[
          {
            id: 'C123',
            name: 'ci-product',
            label: 'Product workspace · #ci-product',
          },
        ]}
        discordOptions={[
          { id: 'D123', name: 'ci', label: 'Engineering · #ci' },
        ]}
        globalDestination={<p>Shared destination</p>}
      />
      <button type="submit">Save</button>
    </form>
  );
}

describe('CI repository group editor', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  it('shows provider/host identity, prevents overlaps, and keeps destinations separate', () => {
    render(<Editor />);
    const groups = screen.getAllByRole('group');
    fireEvent.click(within(groups[0]!).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(groups[1]!).getByRole('button', { name: 'Edit' }));
    expect(
      within(groups[0]!).getByRole('checkbox', {
        name: 'acme/api (gitlab | gitlab.com)',
      }),
    ).toBeChecked();
    expect(
      within(groups[0]!).queryByRole('checkbox', { name: /git\.example\.com/ }),
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

  it('distinguishes same-name repositories across providers and hosts after collapsing', () => {
    render(
      <Editor
        initial={[
          ...initialRoutes,
          { ...initialRoutes[0]!, repositoryIds: ['repo-c'] },
        ]}
      />,
    );
    const labels = [
      'acme/api (gitlab | gitlab.com)',
      'acme/api (gitlab | git.example.com)',
      'acme/api (github | github.com)',
    ];
    for (const [index, label] of labels.entries()) {
      const group = screen.getByRole('group', {
        name: `Repository destination ${index + 1}`,
      });
      fireEvent.click(within(group).getByRole('button', { name: 'Edit' }));
      expect(
        within(group).getByRole('checkbox', { name: label }),
      ).toBeChecked();
      fireEvent.click(within(group).getByRole('button', { name: 'Done' }));
      expect(within(group).queryByRole('checkbox')).not.toBeInTheDocument();
      expect(within(group).getByText(label)).toBeInTheDocument();
    }
  });

  it('removing every group leaves explicit empty scope, not the shared destination', () => {
    render(<Editor />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(
      screen.getByText(
        'No repositories selected. CI Failure Triage will not launch tasks.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Shared destination')).not.toBeInTheDocument();
  });

  it('starts persisted destinations collapsed and reopens them without submitting the parent form', () => {
    const onSave = vi.fn();
    render(<Editor onSave={onSave} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText('Teams · team-a')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Destination channel' }),
      { target: { value: 'updated-team' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Teams · updated-team')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith([
      {
        ...initialRoutes[0],
        target: { ...initialRoutes[0]!.target, externalRef: 'updated-team' },
      },
      initialRoutes[1],
    ]);
  });

  it('keeps a new inline form open until valid Done, shows loaded destination names, and adds another form', async () => {
    render(<Editor initial={[]} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Add repository destination' }),
    );
    expect(
      screen.getByRole('group', { name: 'Repositories' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Send reports to')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /gitlab\.com/ }));
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    fireEvent.keyDown(
      screen.getByRole('combobox', { name: 'Destination provider' }),
      { key: 'ArrowDown' },
    );
    fireEvent.click(await screen.findByRole('option', { name: 'Discord' }));
    fireEvent.keyDown(
      screen.getByRole('combobox', { name: 'Destination channel' }),
      { key: 'ArrowDown' },
    );
    fireEvent.click(
      await screen.findByRole('option', { name: 'Engineering · #ci' }),
    );
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(
      screen.queryByRole('combobox', { name: 'Discord destination type' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Engineering · #ci')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Add repository destination' }),
    );
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(
      screen.queryByRole('checkbox', { name: /gitlab\.com/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /git\.example\.com/ }),
    ).toBeInTheDocument();
  });

  it('keeps labeled controls and completion actions accessible at a mobile viewport', () => {
    const previousWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 375,
    });
    try {
      render(<Editor />);
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
      expect(
        screen.getByRole('group', { name: 'Repositories' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('textbox', { name: 'Destination channel' }),
      ).toHaveValue('team-a');
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: previousWidth,
      });
    }
  });

  it('uses loaded Slack labels for persisted summaries', () => {
    render(
      <Editor
        initial={[
          {
            repositoryIds: ['repo-a'],
            target: {
              provider: 'slack',
              targetKind: 'slack_channel',
              externalRef: 'C123',
            },
          },
        ]}
      />,
    );
    expect(
      screen.getByText('Product workspace · #ci-product'),
    ).toBeInTheDocument();
    expect(screen.queryByText('C123')).not.toBeInTheDocument();
  });

  it('keeps an edited destination open when an earlier entry is removed', () => {
    render(<Editor />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(
      screen.getByRole('textbox', { name: 'Destination channel' }),
    ).toHaveValue('chat-b');
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Destination channel' }),
      { target: { value: '   ' } },
    );
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
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
