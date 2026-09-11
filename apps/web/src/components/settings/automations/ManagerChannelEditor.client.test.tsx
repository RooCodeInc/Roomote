import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
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

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.getClientRects = () =>
    [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
});

async function flushCloseAutoFocus() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

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

  it('focuses manual channel entry after that option is committed', async () => {
    function Example() {
      const [value, setValue] = useState({
        slackChannel: '',
        discordChannel: '',
      });
      return (
        <ManagerChannelEditor
          {...baseProps}
          value={value}
          savedSlackChannel=""
          savedSlackChannelId={null}
          onChange={setValue}
        />
      );
    }

    render(<Example />);
    fireEvent.click(screen.getByLabelText('Select manager channel'));
    fireEvent.click(
      screen.getByRole('option', { name: 'Private or manual channel' }),
    );
    await flushCloseAutoFocus();

    expect(
      screen.getByPlaceholderText(
        'Enter a private channel name or Slack channel ID',
      ),
    ).toHaveFocus();
  });
});
