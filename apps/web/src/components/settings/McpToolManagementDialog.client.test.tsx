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
          description: null,
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
  useSetDisabledMcpTools: () => ({
    isPending: false,
    mutate: vi.fn(),
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
    expect(state.policiesQueryEnabled).toBe(false);
    state.policiesQueryEnabled = undefined;
    renderDialog({ open: true, isAdmin: false });
    expect(state.policiesQueryEnabled).toBe(false);
    state.policiesQueryEnabled = undefined;
    renderDialog({ open: true, isAdmin: true });
    expect(state.policiesQueryEnabled).toBe(true);
  });

  it('shows per-tool approval modes with persisted values and saves changes in one click', () => {
    state.approvalsEnabled = true;
    state.policies = [
      { integrationId: 'exa', toolName: 'web_fetch_exa', mode: 'reject' },
    ];
    renderDialog();

    const search = within(
      screen.getByRole('radiogroup', {
        name: 'Approval mode for web_search_exa',
      }),
    );
    expect(search.getByRole('radio', { name: 'Always allow' })).toBeChecked();
    expect(
      within(
        screen.getByRole('radiogroup', {
          name: 'Approval mode for web_fetch_exa',
        }),
      ).getByRole('radio', { name: 'Reject' }),
    ).toBeChecked();

    fireEvent.click(search.getByRole('radio', { name: 'Ask first' }));
    expect(state.setModeCalls).toEqual([
      { integrationId: 'exa', toolName: 'web_search_exa', mode: 'ask' },
    ]);
  });

  it('shows unclassified tools as a plain list with one Custom bulk select', () => {
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
    expect(
      screen.getByRole('combobox', { name: 'Approval mode for all tools' }),
    ).toHaveTextContent('Custom');
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
      readOnly.getByRole('radiogroup', {
        name: 'Approval mode for web_search_exa',
      }),
    ).toBeInTheDocument();
    const write = screen.getByRole('region', { name: 'Write/delete tools' });
    const groupSelect = within(write).getByRole('combobox', {
      name: 'Approval mode for all write/delete tools',
    });
    expect(groupSelect).toHaveTextContent('Ask first');

    fireEvent.click(groupSelect);
    fireEvent.click(await screen.findByRole('option', { name: 'Reject' }));
    expect(state.setModesCalls).toEqual([
      { integrationId: 'exa', toolNames: ['web_fetch_exa'], mode: 'reject' },
    ]);
  });
});
