import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ManagerChannelEditor } from './ManagerChannelEditor';

const baseProps = {
  value: { slackChannel: '#roomote-managers', discordChannel: '' },
  savedSlackChannel: '#roomote-managers',
  savedSlackChannelId: 'C123MANAGER',
  savedDiscordChannelId: null,
  slackChannels: [{ id: 'C123MANAGER', name: 'roomote-managers' }],
  discordChannels: [],
  slackConnected: true,
  discordConnected: false,
  channelsPending: false,
  channelsFetching: false,
  channelsError: false,
  isDirty: false,
  isSaving: false,
  warningChannelId: null,
  slackAppMention: '@Roomote',
  fieldError: undefined,
  showMigrationNote: false,
  onChange: vi.fn(),
  onRefresh: vi.fn(),
  onSave: vi.fn(),
  onReset: vi.fn(),
};

describe('ManagerChannelEditor', () => {
  it('keeps refresh available when the channel catalog fails to load', () => {
    const onRefresh = vi.fn();
    render(
      <ManagerChannelEditor
        {...baseProps}
        value={{ slackChannel: '', discordChannel: '' }}
        savedSlackChannel=""
        savedSlackChannelId={null}
        slackChannels={[]}
        channelsError
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh channels' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('closes the editor after a successful save transition', async () => {
    const { rerender } = render(<ManagerChannelEditor {...baseProps} />);

    fireEvent.click(screen.getByRole('button', { name: /#roomote-managers/ }));
    expect(screen.getByLabelText('Select manager channel')).toBeInTheDocument();

    rerender(<ManagerChannelEditor {...baseProps} isDirty isSaving />);
    rerender(<ManagerChannelEditor {...baseProps} />);

    await waitFor(() => {
      expect(
        screen.queryByLabelText('Select manager channel'),
      ).not.toBeInTheDocument();
    });
  });
});
