import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  autoEnabled: false,
  policies: [] as { integrationId: string; toolName: string; mode: string }[],
  setModeCalls: [] as {
    integrationId: string;
    toolName: string;
    mode: string;
  }[],
  setModesCalls: [] as {
    integrationId: string;
    toolNames: string[];
    mode: string;
  }[],
  annotated: false,
  searchDescription: null as string | null,
  policiesQueryEnabled: undefined as boolean | undefined,
  policiesUpdating: false,
}));

vi.mock('@/hooks/useIntegrationToolAutoApprovalsExperiment', () => ({
  useIntegrationToolAutoApprovalsExperiment: () => ({
    enabled: state.autoEnabled,
    isLoading: false,
    isUpdating: false,
    setEnabled: vi.fn(),
  }),
}));

vi.mock('@/hooks/useIntegrationToolPolicies', () => ({
  useIntegrationToolPolicies: (options?: { enabled?: boolean }) => {
    state.policiesQueryEnabled = options?.enabled;
    return {
      isLoading: false,
      isUpdating: state.policiesUpdating,
      modes: new Map(
        state.policies.map((policy) => [
          JSON.stringify([policy.integrationId, policy.toolName]),
          policy.mode,
        ]),
      ),
      setMode: (integrationId: string, toolName: string, mode: string) => {
        state.setModeCalls.push({ integrationId, toolName, mode });
      },
      setModes: (integrationId: string, toolNames: string[], mode: string) => {
        state.setModesCalls.push({ integrationId, toolNames, mode });
      },
    };
  },
}));

vi.mock('@/hooks/mcp-connections', () => ({
  useMcpConnectionTools: () => ({
    data: {
      mcpId: 'exa',
      tools: [
        {
          name: 'web_search_exa',
          description: state.searchDescription,
          enabled: true,
          readOnly: state.annotated ? true : null,
        },
        {
          name: 'web_fetch_exa',
          description: null,
          enabled: true,
          readOnly: state.annotated ? false : null,
        },
      ],
    },
    isPending: false,
    isError: false,
    status: 'success' as const,
  }),
}));

import { McpToolManagementDialog } from './McpToolManagementDialog';

function renderDialog(props?: { open?: boolean; isAdmin?: boolean }) {
  return render(
    <McpToolManagementDialog
      mcpId="exa"
      integrationName="Exa"
      open={props?.open ?? true}
      onOpenChange={() => undefined}
      {...(props?.isAdmin === undefined ? {} : { isAdmin: props.isAdmin })}
    />,
  );
}

describe('McpToolManagementDialog tool approvals', () => {
  beforeEach(() => {
    state.autoEnabled = false;
    state.policies = [];
    state.setModeCalls = [];
    state.setModesCalls = [];
    state.annotated = false;
    state.policiesUpdating = false;
    // Radix Select scrolls the highlighted option into view; jsdom lacks it.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the approval choices with no experiment, a default tool as Always allow while Auto is off', () => {
    state.searchDescription = 'Search the web with Exa.';
    try {
      renderDialog();
      expect(screen.getByText('Web Search Exa')).toHaveAttribute(
        'title',
        'web_search_exa',
      );
      expect(screen.getByText('Search the web with Exa.')).toBeInTheDocument();
      const search = within(
        screen.getByRole('group', {
          name: 'Approval mode for web_search_exa',
        }),
      );
      expect(
        search.getByRole('button', { name: 'Always allow' }),
      ).toHaveAttribute('aria-pressed', 'true');
      // Auto is experimental: without it the group row offers no Auto.
      expect(
        within(
          screen.getByRole('group', { name: 'Approval mode for all tools' }),
        ).queryByRole('button', { name: 'Auto' }),
      ).toBeNull();
      // The old enable checkboxes and their Save footer are gone: Disable
      // replaces them.
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    } finally {
      state.searchDescription = null;
    }
  });

  it('does not fire the admin-only policy query while the dialog is closed or for non-admin viewers', () => {
    state.autoEnabled = true;
    state.policiesQueryEnabled = undefined;
    renderDialog({ open: false, isAdmin: true });
    // A closed dialog never mounts the tool list, so the query hook never runs.
    expect(state.policiesQueryEnabled).not.toBe(true);
    state.policiesQueryEnabled = undefined;
    renderDialog({ open: true, isAdmin: false });
    expect(state.policiesQueryEnabled).toBe(false);
    state.policiesQueryEnabled = undefined;
    renderDialog({ open: true, isAdmin: true });
    expect(state.policiesQueryEnabled).toBe(true);
  });

  it('shows the three stored choices with Auto as nothing pressed and saves changes in one click', () => {
    state.autoEnabled = true;
    state.policies = [
      { integrationId: 'exa', toolName: 'web_fetch_exa', mode: 'reject' },
    ];
    renderDialog();

    const search = within(
      screen.getByRole('group', {
        name: 'Approval mode for web_search_exa',
      }),
    );
    // Auto, the default, is nothing pressed, and it is not a button of its own.
    expect(
      search.getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['', '', '']);
    expect(search.queryByRole('button', { name: 'Auto' })).toBeNull();
    for (const button of search.getAllByRole('button')) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
    expect(
      within(
        screen.getByRole('group', {
          name: 'Approval mode for web_fetch_exa',
        }),
      ).getByRole('button', { name: 'Disable' }),
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(search.getByRole('button', { name: 'Always ask' }));
    expect(state.setModeCalls).toEqual([
      { integrationId: 'exa', toolName: 'web_search_exa', mode: 'ask' },
    ]);
    // Clicking the selected choice again returns the tool to Auto.
    fireEvent.click(
      within(
        screen.getByRole('group', {
          name: 'Approval mode for web_fetch_exa',
        }),
      ).getByRole('button', { name: 'Disable' }),
    );
    expect(state.setModeCalls.at(-1)).toEqual({
      integrationId: 'exa',
      toolName: 'web_fetch_exa',
      mode: 'allow',
    });
  });

  it('keeps approval mode buttons enabled while a policy save is pending', () => {
    state.autoEnabled = true;
    state.policiesUpdating = true;
    renderDialog();

    const search = within(
      screen.getByRole('group', {
        name: 'Approval mode for web_search_exa',
      }),
    );
    const allTools = within(
      screen.getByRole('group', {
        name: 'Approval mode for all tools',
      }),
    );

    expect(search.getByRole('button', { name: 'Always ask' })).toBeEnabled();
    expect(allTools.getByRole('button', { name: 'Disable' })).toBeEnabled();
  });

  it('shows unclassified tools as a plain list with a mixed group row', () => {
    state.autoEnabled = true;
    state.policies = [
      { integrationId: 'exa', toolName: 'web_fetch_exa', mode: 'reject' },
    ];
    renderDialog();
    // No heading to collapse when the server classifies nothing.
    expect(
      screen.queryByRole('button', { expanded: true }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Read-only tools' }),
    ).not.toBeInTheDocument();
    const group = within(
      screen.getByRole('group', {
        name: 'Approval mode for all tools',
      }),
    );
    for (const button of group.getAllByRole('button')) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }

    fireEvent.click(group.getByRole('button', { name: 'Disable' }));
    expect(state.setModesCalls).toEqual([
      {
        integrationId: 'exa',
        toolNames: ['web_search_exa', 'web_fetch_exa'],
        mode: 'reject',
      },
    ]);
    // Only the group row offers Auto, returning every tool to the default.
    fireEvent.click(group.getByRole('button', { name: 'Auto' }));
    expect(state.setModesCalls.at(-1)).toEqual({
      integrationId: 'exa',
      toolNames: ['web_search_exa', 'web_fetch_exa'],
      mode: 'allow',
    });
  });

  it('groups annotated tools by access and sets a whole group at once', async () => {
    state.autoEnabled = true;
    state.annotated = true;
    state.policies = [
      { integrationId: 'exa', toolName: 'web_fetch_exa', mode: 'ask' },
    ];
    renderDialog();

    const readOnly = within(
      screen.getByRole('region', { name: 'Read-only tools' }),
    );
    expect(
      readOnly.getByRole('group', {
        name: 'Approval mode for web_search_exa',
      }),
    ).toBeInTheDocument();
    const write = screen.getByRole('region', { name: 'Write/delete tools' });
    const group = within(write).getByRole('group', {
      name: 'Approval mode for all write/delete tools',
    });
    expect(
      within(group).getByRole('button', { name: 'Always ask' }),
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(group).getByRole('button', { name: 'Disable' }));
    expect(state.setModesCalls).toEqual([
      { integrationId: 'exa', toolNames: ['web_fetch_exa'], mode: 'reject' },
    ]);
  });

  it('uses the requested dialog size and exact mode tooltip', async () => {
    state.autoEnabled = true;
    renderDialog();

    expect(screen.getByRole('dialog')).toHaveClass('md:max-w-2xl');

    const search = within(
      screen.getByRole('group', {
        name: 'Approval mode for web_search_exa',
      }),
    );
    // The dialog focuses its first button on open, which opens that button's
    // tooltip; focusing the one under test moves the tooltip to it.
    fireEvent.focus(search.getByRole('button', { name: 'Always ask' }));
    expect(
      await screen.findByRole('tooltip', { name: 'Always ask' }),
    ).toBeInTheDocument();
  });
});
