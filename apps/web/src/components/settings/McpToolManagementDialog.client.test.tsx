import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  approvalsEnabled: false,
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
}));

vi.mock('@/hooks/useIntegrationToolApprovalsExperiment', () => ({
  useIntegrationToolApprovalsExperiment: () => ({
    enabled: state.approvalsEnabled,
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
      isUpdating: false,
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
    state.approvalsEnabled = false;
    state.policies = [];
    state.setModeCalls = [];
    state.setModesCalls = [];
    state.annotated = false;
    // Radix Select scrolls the highlighted option into view; jsdom lacks it.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows each tool with a readable name and its description without availability checkboxes', () => {
    state.searchDescription = 'Search the web with Exa.';
    try {
      renderDialog();
      expect(screen.getByText('Web Search Exa')).toHaveAttribute(
        'title',
        'web_search_exa',
      );
      expect(screen.getByText('Search the web with Exa.')).toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    } finally {
      state.searchDescription = null;
    }
  });

  it('hides per-tool approval modes while the experiment is off', () => {
    renderDialog();
    expect(
      screen.queryByLabelText('Approval mode for web_search_exa'),
    ).not.toBeInTheDocument();
  });

  it('does not fire the admin-only policy query while the dialog is closed or for non-admin viewers', () => {
    state.approvalsEnabled = true;
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

  it('shows the four approval modes in Auto-first order and saves changes in one click', () => {
    state.approvalsEnabled = true;
    state.policies = [
      { integrationId: 'exa', toolName: 'web_fetch_exa', mode: 'reject' },
    ];
    renderDialog();

    const search = within(
      screen.getByRole('group', {
        name: 'Approval mode for web_search_exa',
      }),
    );
    expect(
      search.getAllByRole('button').map((button) => button.textContent),
    ).toEqual(['Auto', '', '', '']);
    expect(
      search.getByRole('button', { name: 'Always allow' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(
        screen.getByRole('group', {
          name: 'Approval mode for web_fetch_exa',
        }),
      ).getByRole('button', { name: 'Disable' }),
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(search.getByRole('button', { name: 'Always ask' }));
    fireEvent.click(search.getByRole('button', { name: 'Auto' }));
    expect(state.setModeCalls).toEqual([
      { integrationId: 'exa', toolName: 'web_search_exa', mode: 'ask' },
      { integrationId: 'exa', toolName: 'web_search_exa', mode: 'auto' },
    ]);
  });

  it('shows unclassified tools as a plain list with a mixed group row', () => {
    state.approvalsEnabled = true;
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
  });

  it('groups annotated tools by access and sets a whole group at once', async () => {
    state.approvalsEnabled = true;
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
    state.approvalsEnabled = true;
    renderDialog();

    expect(screen.getByRole('dialog')).toHaveClass('md:max-w-2xl');

    const search = within(
      screen.getByRole('group', {
        name: 'Approval mode for web_search_exa',
      }),
    );
    fireEvent.mouseOver(search.getByRole('button', { name: 'Auto' }));
    expect(
      await screen.findByRole('tooltip', {
        name: 'Defer to the configured judgement model',
      }),
    ).toBeInTheDocument();
  });
});
