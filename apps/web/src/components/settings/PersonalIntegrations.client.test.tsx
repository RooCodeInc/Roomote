// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IntegrationItem } from './integration-card';
import { PersonalIntegrations } from './PersonalIntegrations';

const { mcpState, keyState } = vi.hoisted(() => ({
  mcpState: {
    isEnabled: true,
    isLoading: false,
    error: null as string | null,
    items: [] as IntegrationItem[],
    openAddDialog: vi.fn(),
  },
  keyState: {
    isLoading: false,
    error: null as string | null,
    items: [] as IntegrationItem[],
    openAddDialog: vi.fn(),
  },
}));

vi.mock('./CustomMcpServers', () => ({
  useCustomMcpServers: () => ({ ...mcpState, dialogs: <div>mcp dialogs</div> }),
}));

vi.mock('./YourIntegrations', () => ({
  useYourIntegrations: () => ({ ...keyState, dialogs: <div>key dialogs</div> }),
}));

function buildItem(id: string, name: string): IntegrationItem {
  return {
    id,
    name,
    description: `${name} description`,
    enabled: true,
    icon: null,
    isMcpBased: true,
    isPending: false,
  };
}

describe('PersonalIntegrations', () => {
  afterEach(() => {
    cleanup();
    mcpState.isEnabled = true;
    mcpState.isLoading = false;
    mcpState.error = null;
    mcpState.items = [];
    keyState.isLoading = false;
    keyState.error = null;
    keyState.items = [];
    vi.clearAllMocks();
  });

  it('lists MCP servers and API-key integrations in one table', () => {
    mcpState.items = [buildItem('mcp-1', 'deepwiki')];
    keyState.items = [buildItem('key-1', 'Acme analytics')];
    render(<PersonalIntegrations />);

    const table = screen.getByRole('table', { name: 'Personal integrations' });
    expect(table).toHaveTextContent('deepwiki');
    expect(table).toHaveTextContent('Acme analytics');
    expect(screen.queryByText('No personal integrations yet.')).toBeNull();
    // One section, so one of each dialog set, mounted once.
    expect(screen.getByText('mcp dialogs')).toBeInTheDocument();
    expect(screen.getByText('key dialogs')).toBeInTheDocument();
  });

  it('offers both routes behind a single add action', async () => {
    render(<PersonalIntegrations />);

    expect(
      screen.queryByRole('button', { name: /Add personal MCP server/ }),
    ).toBeNull();
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Add personal integration' }),
      { key: 'Enter' },
    );

    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Custom MCP' }),
    );
    expect(mcpState.openAddDialog).toHaveBeenCalledTimes(1);
    expect(keyState.openAddDialog).not.toHaveBeenCalled();
  });

  it('shows an empty state only when neither source has anything', () => {
    render(<PersonalIntegrations />);

    expect(
      screen.getByText('No personal integrations yet.'),
    ).toBeInTheDocument();
  });

  it('surfaces a failure from either source instead of the empty state', () => {
    mcpState.error = 'MCP servers are unavailable.';
    keyState.error = 'Integrations are unavailable.';
    render(<PersonalIntegrations />);

    const alerts = screen.getAllByRole('alert').map((el) => el.textContent);
    expect(alerts).toEqual([
      'MCP servers are unavailable.',
      'Integrations are unavailable.',
    ]);
    expect(screen.queryByText('No personal integrations yet.')).toBeNull();
  });
});
