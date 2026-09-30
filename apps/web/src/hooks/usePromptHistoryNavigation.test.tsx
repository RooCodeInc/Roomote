import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import { usePromptHistoryNavigation } from './usePromptHistoryNavigation';

function HistoryTextarea({ history }: { history: readonly string[] }) {
  const [value, setValue] = useState('');
  const handleHistoryKeyDown = usePromptHistoryNavigation({
    history,
    value,
    onNavigate: setValue,
  });

  return (
    <textarea
      aria-label="Prompt"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={handleHistoryKeyDown}
    />
  );
}

describe('usePromptHistoryNavigation', () => {
  it('recalls the latest prompt and walks backward while it remains unchanged', () => {
    render(<HistoryTextarea history={['first prompt', 'latest prompt']} />);
    const textarea = screen.getByRole('textbox', {
      name: 'Prompt',
    }) as HTMLTextAreaElement;

    expect(fireEvent.keyDown(textarea, { key: 'ArrowUp' })).toBe(false);
    expect(textarea).toHaveValue('latest prompt');
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(0);

    expect(fireEvent.keyDown(textarea, { key: 'ArrowUp' })).toBe(false);
    expect(textarea).toHaveValue('first prompt');
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(0);
  });

  it('does not intercept ArrowUp without history', () => {
    render(<HistoryTextarea history={[]} />);
    const textarea = screen.getByRole('textbox', { name: 'Prompt' });

    expect(fireEvent.keyDown(textarea, { key: 'ArrowUp' })).toBe(true);
    expect(textarea).toHaveValue('');
  });

  it('does not intercept ArrowUp when the cursor is not at position zero', () => {
    render(<HistoryTextarea history={['previous prompt']} />);
    const textarea = screen.getByRole('textbox', {
      name: 'Prompt',
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'draft' } });
    textarea.setSelectionRange(3, 3);

    expect(fireEvent.keyDown(textarea, { key: 'ArrowUp' })).toBe(true);
    expect(textarea).toHaveValue('draft');
  });

  it('preserves ordinary multiline navigation', () => {
    render(<HistoryTextarea history={['previous prompt']} />);
    const textarea = screen.getByRole('textbox', {
      name: 'Prompt',
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: 'first line\nsecond line' },
    });
    textarea.setSelectionRange(18, 18);

    expect(fireEvent.keyDown(textarea, { key: 'ArrowUp' })).toBe(true);
    expect(textarea).toHaveValue('first line\nsecond line');
  });

  it('stops history navigation after the recalled prompt is edited', () => {
    render(<HistoryTextarea history={['first prompt', 'latest prompt']} />);
    const textarea = screen.getByRole('textbox', { name: 'Prompt' });

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    fireEvent.change(textarea, { target: { value: 'latest prompt edited' } });
    fireEvent.change(textarea, { target: { value: 'latest prompt' } });

    expect(fireEvent.keyDown(textarea, { key: 'ArrowUp' })).toBe(true);
    expect(textarea).toHaveValue('latest prompt');
  });
});
