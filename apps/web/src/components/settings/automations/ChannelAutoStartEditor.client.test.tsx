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
  it('updates launch criteria within the edited row', () => {
    const { onRowsChange } = renderEditor([
      {
        slackChannel: '#bugs',
        instructions: 'Treat each message as a bug report.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: '',
      },
      {
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

    expect(onRowsChange).toHaveBeenCalledWith([
      {
        slackChannel: '#bugs',
        instructions: 'Treat each message as a bug report.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: 'Only launch on new production incidents.',
      },
      {
        slackChannel: '#ops',
        instructions: 'Treat each message as an incident.',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: 'Only launch on new incidents.',
      },
    ]);
  });

  it('adds an empty row when the add button is pressed', () => {
    const { onRowsChange } = renderEditor([]);

    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));

    expect(onRowsChange).toHaveBeenCalledWith([
      {
        slackChannel: '',
        instructions: '',
        launchMode: DEFAULT_CHANNEL_AUTO_START_LAUNCH_MODE,
        launchCriteria: '',
      },
    ]);
  });
});
