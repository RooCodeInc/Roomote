import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

import type { IntegrationToolSessionOverrideMetadata } from '@roomote/types';

import {
  IntegrationToolSessionControlsProvider,
  IntegrationToolSessionMenu,
} from './IntegrationToolSessionControls';

const tool = { integrationId: 'mock-slack', toolName: 'post_message' };

function renderMenu(input: {
  active?: boolean;
  overrides?: IntegrationToolSessionOverrideMetadata[];
}) {
  const setOverride = vi.fn();
  render(
    <IntegrationToolSessionControlsProvider
      active={input.active ?? true}
      overrides={input.overrides ?? []}
      setOverride={setOverride}
      isUpdating={false}
    >
      <IntegrationToolSessionMenu {...tool} />
    </IntegrationToolSessionControlsProvider>,
  );
  return { setOverride };
}

const trigger = () =>
  screen.queryByRole('button', {
    name: 'Approval for post_message in this session',
  });

describe('IntegrationToolSessionMenu', () => {
  it('renders nothing outside an active Session owner transcript', () => {
    render(<IntegrationToolSessionMenu {...tool} />);
    expect(trigger()).not.toBeInTheDocument();

    renderMenu({ active: false });
    expect(trigger()).not.toBeInTheDocument();
  });

  it('lets the requester ask to be asked about a tool for the session', async () => {
    const { setOverride } = renderMenu({});
    fireEvent.keyDown(trigger()!, { key: 'Enter' });
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: 'Ask me for this tool this session',
      }),
    );
    expect(setOverride).toHaveBeenCalledWith({ ...tool, mode: 'ask' });
  });

  it('clears a session ask override', async () => {
    const { setOverride } = renderMenu({
      overrides: [{ ...tool, mode: 'ask' }],
    });
    fireEvent.keyDown(trigger()!, { key: 'Enter' });
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Stop asking this session' }),
    );
    expect(setOverride).toHaveBeenCalledWith({ ...tool, mode: null });
  });

  it('offers both re-asking and resetting after "don\'t ask again"', async () => {
    const { setOverride } = renderMenu({
      overrides: [{ ...tool, mode: 'allow' }],
    });
    fireEvent.keyDown(trigger()!, { key: 'Enter' });
    expect(
      await screen.findByRole('menuitem', {
        name: 'Ask me for this tool this session',
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Reset to the default' }),
    );
    expect(setOverride).toHaveBeenCalledWith({ ...tool, mode: null });
  });

  it('keeps another tool with the same flattened name separate', async () => {
    renderMenu({
      overrides: [
        { integrationId: 'mock', toolName: 'slack_post_message', mode: 'ask' },
      ],
    });
    fireEvent.keyDown(trigger()!, { key: 'Enter' });
    expect(
      await screen.findByRole('menuitem', {
        name: 'Ask me for this tool this session',
      }),
    ).toBeInTheDocument();
  });
});
