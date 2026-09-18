import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';

import { AutomationDefaultDestinationSetting } from './AutomationDefaultDestinationSetting';

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.getClientRects = () =>
    [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
});

const slackDm = {
  provider: 'slack',
  mode: 'direct_message',
  channelId: '',
} as const;

function renderSetting(
  overrides: Partial<
    ComponentProps<typeof AutomationDefaultDestinationSetting>
  > = {},
) {
  const props: ComponentProps<typeof AutomationDefaultDestinationSetting> = {
    value: slackDm,
    savedValue: slackDm,
    savedOwner: { name: 'Ada Admin', isViewer: false },
    availableProviders: ['slack'],
    slackOptions: [],
    discordOptions: [],
    emailOptions: [],
    isDirty: false,
    isSaving: false,
    onChange: vi.fn(),
    onSave: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
  render(<AutomationDefaultDestinationSetting {...props} />);
  return props;
}

describe('AutomationDefaultDestinationSetting', () => {
  it('names the admin a saved DM default belongs to', () => {
    renderSetting();

    expect(screen.getByText('Slack DM to Ada Admin')).toBeInTheDocument();
    expect(screen.queryByText('Slack DM to you')).not.toBeInTheDocument();
  });

  it('addresses the viewer when they own the saved DM default', () => {
    renderSetting({ savedOwner: { name: 'Ada Admin', isViewer: true } });

    expect(screen.getByText('Slack DM to you')).toBeInTheDocument();
  });

  it('keeps the dialog open until the save is accepted', () => {
    let accept: () => void = () => {};
    const onSave = vi.fn((onSaved: () => void) => {
      accept = onSaved;
    });
    renderSetting({ isDirty: true, onSave, error: 'Connect slack first.' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save destination' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Connect slack first.');

    act(() => accept());

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
