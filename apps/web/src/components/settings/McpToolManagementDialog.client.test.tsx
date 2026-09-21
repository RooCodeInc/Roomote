import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  approvalsEnabled: false,
  policies: [] as { integrationId: string; toolName: string; mode: string }[],
  setModeCalls: [] as {
    integrationId: string;
    toolName: string;
    mode: string;
  }[],
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
  useIntegrationToolPolicies: () => ({
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
  }),
}));

vi.mock('@/hooks/mcp-connections', () => ({
  useMcpConnectionTools: () => ({
    data: {
      mcpId: 'exa',
      tools: [
        { name: 'web_search_exa', description: null, enabled: true },
        { name: 'web_fetch_exa', description: null, enabled: true },
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

function renderDialog() {
  return render(
    <McpToolManagementDialog
      mcpId="exa"
      integrationName="Exa"
      open={true}
      onOpenChange={() => undefined}
    />,
  );
}

describe('McpToolManagementDialog tool approvals', () => {
  beforeEach(() => {
    state.approvalsEnabled = false;
    state.policies = [];
    state.setModeCalls = [];
    // Radix Select scrolls the highlighted option into view; jsdom lacks it.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('hides per-tool approval modes while the experiment is off', () => {
    renderDialog();
    expect(
      screen.queryByLabelText('Approval mode for web_search_exa'),
    ).not.toBeInTheDocument();
  });

  it('shows per-tool approval modes with persisted values and saves changes immediately', async () => {
    state.approvalsEnabled = true;
    state.policies = [
      { integrationId: 'exa', toolName: 'web_fetch_exa', mode: 'reject' },
    ];
    renderDialog();

    const searchSelect = screen.getByLabelText(
      'Approval mode for web_search_exa',
    );
    expect(searchSelect).toHaveTextContent('Always allow (default)');
    expect(
      screen.getByLabelText('Approval mode for web_fetch_exa'),
    ).toHaveTextContent('Always reject');

    fireEvent.click(searchSelect);
    fireEvent.click(
      await screen.findByRole('option', { name: 'Ask every time' }),
    );
    expect(state.setModeCalls).toEqual([
      { integrationId: 'exa', toolName: 'web_search_exa', mode: 'ask' },
    ]);
  });
});
