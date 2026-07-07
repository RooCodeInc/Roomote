import { fireEvent, render, screen } from '@testing-library/react';

import type { Command } from '@roomote/types';

import { CommandListEditor } from './CommandListEditor';

describe('CommandListEditor', () => {
  it('uses a multiline control for command bodies and preserves newlines', () => {
    const onChange = vi.fn();
    const commands: Command[] = [
      {
        name: 'Bootstrap',
        run: 'pnpm install',
        timeout: 600,
        continue_on_error: false,
      },
    ];

    render(<CommandListEditor commands={commands} onChange={onChange} />);

    const commandRun = screen.getByLabelText('Command run');

    expect(commandRun.tagName).toBe('TEXTAREA');
    expect(commandRun).toHaveAttribute('rows', '1');
    expect(commandRun.className).toContain('resize-y');

    fireEvent.change(commandRun, {
      target: {
        value: 'pnpm install\npnpm dev',
      },
    });

    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        name: 'Bootstrap',
        run: 'pnpm install\npnpm dev',
      }),
    ]);
  });

  it('stacks command and description fields while aligning remove with the command label', () => {
    const onChange = vi.fn();
    const commands: Command[] = [
      {
        name: 'Install Zero',
        run: 'curl -fsSL https://zero.xyz/install.sh | bash',
        timeout: 600,
        continue_on_error: false,
      },
    ];

    render(<CommandListEditor commands={commands} onChange={onChange} />);

    const commandRun = screen.getByLabelText('Command run');
    const description = screen.getByLabelText('Command description');
    const commandLabel = screen.getByText('Command');
    const removeButton = screen.getByLabelText('Remove Install Zero');
    const removeButtonRow = removeButton.parentElement;
    const commandField = commandRun.parentElement;
    const descriptionField = description.parentElement;

    expect(removeButtonRow).toHaveClass('flex', 'justify-between');
    expect(removeButtonRow).toContainElement(commandLabel);
    expect(removeButtonRow?.nextElementSibling).toBe(commandRun);
    expect(commandField?.nextElementSibling).toBe(descriptionField);
  });
});
