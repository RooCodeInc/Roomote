import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE } from '@roomote/types';

import { ChannelAutoStartEditor } from './ChannelAutoStartEditor';
import type { ChannelAutoStartFormRow } from './formState';

const launchModeOptions = [
  {
    value: 'always_start' as const,
    label: 'Always start a task',
    description: 'Launch for every message.',
    instructionsLabel: 'Task instructions (optional)',
    instructionsHint: 'Used when the task starts.',
    instructionsPlaceholder: 'Treat each message as a bug report.',
  },
];

function renderEditor(rows: ChannelAutoStartFormRow[]) {
  const onRowsChange = vi.fn();

  render(
    <ChannelAutoStartEditor
      slackAppMention="@roomote"
      rows={rows}
      launchModeOptions={launchModeOptions}
      showLaunchModePicker={true}
      availableTemplates={[]}
      isEnabled={rows.some((row) => row.slackChannel.trim().length > 0)}
      onRowsChange={onRowsChange}
    />,
  );

  return { onRowsChange };
}

describe('ChannelAutoStartEditor', () => {
  it('updates launch criteria within the edited row while keeping every persisted channel id', () => {
    const { onRowsChange } = renderEditor([
      {
        channelId: 'C0BUGS',
        slackChannel: '#bugs',
        instructions: 'Treat each message as a bug report.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: '',
      },
      {
        channelId: 'C0OPS',
        slackChannel: '#ops',
        instructions: 'Treat each message as an incident.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: 'Only launch on new incidents.',
      },
    ]);

    fireEvent.change(
      screen.getAllByLabelText('Launch criteria (optional)')[0]!,
      {
        target: { value: 'Only launch on new production incidents.' },
      },
    );

    // Editing a non-channel field must preserve the persisted channel ids so
    // the server keeps resolving those rows by id rather than by name.
    expect(onRowsChange).toHaveBeenCalledWith([
      {
        channelId: 'C0BUGS',
        slackChannel: '#bugs',
        instructions: 'Treat each message as a bug report.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: 'Only launch on new production incidents.',
      },
      {
        channelId: 'C0OPS',
        slackChannel: '#ops',
        instructions: 'Treat each message as an incident.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: 'Only launch on new incidents.',
      },
    ]);
  });

  it('clears the persisted channel id when the channel field is edited', () => {
    const { onRowsChange } = renderEditor([
      {
        channelId: 'C0BUGS',
        slackChannel: '#bugs',
        instructions: 'Treat each message as a bug report.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: '',
      },
    ]);

    fireEvent.change(screen.getByLabelText('Monitor this Slack channel'), {
      target: { value: '#bugs-triage' },
    });

    // A changed channel invalidates the persisted id, so it must be dropped and
    // re-resolved from the new name on save.
    expect(onRowsChange).toHaveBeenCalledWith([
      {
        channelId: null,
        slackChannel: '#bugs-triage',
        instructions: 'Treat each message as a bug report.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: '',
      },
    ]);
  });

  it('adds an empty row when the add button is pressed', () => {
    const { onRowsChange } = renderEditor([]);

    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));

    expect(onRowsChange).toHaveBeenCalledWith([
      {
        channelId: null,
        slackChannel: '',
        instructions: '',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: '',
      },
    ]);
  });
});
