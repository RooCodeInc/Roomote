import { fireEvent, render, screen } from '@testing-library/react';

import { PromptTemplates } from './PromptTemplates';

let userId = 'user-1';
vi.mock('@/hooks/useUser', () => ({ useAuthorizedUser: () => ({ userId }) }));

const key = 'roomote-prompt-templates:v1:user-1';
const prompt = '  Review this code\n\nKeep $variables and <tags>.  ';
const open = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Templates' }));
const save = (name: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save current prompt' }));
};
const stored = () => JSON.parse(localStorage.getItem(key) ?? 'null');

describe('PromptTemplates', () => {
  beforeEach(() => {
    userId = 'user-1';
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('saves named exact text, persists across mounts, loads without launching, and deletes one item', () => {
    const onLoad = vi.fn();
    const first = render(<PromptTemplates prompt={prompt} onLoad={onLoad} />);
    open();
    save('Review');
    save('Other');
    expect(stored()).toEqual({
      version: 1,
      templates: [
        { name: 'Review', prompt },
        { name: 'Other', prompt },
      ],
    });
    expect(onLoad).not.toHaveBeenCalled();
    first.unmount();
    render(<PromptTemplates prompt="" onLoad={onLoad} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Load Review' }));
    expect(onLoad).toHaveBeenCalledWith(prompt);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Review' }));
    expect(stored().templates).toEqual([{ name: 'Other', prompt }]);
  });

  it('rejects blank inputs and case-insensitive duplicate names without overwriting', () => {
    const view = render(<PromptTemplates prompt={' \n '} onLoad={vi.fn()} />);
    open();
    save('Review');
    expect(screen.getByRole('alert')).toHaveTextContent('non-empty prompt');
    view.rerender(<PromptTemplates prompt={prompt} onLoad={vi.fn()} />);
    save('   ');
    expect(localStorage.getItem(key)).toBeNull();
    save('Review');
    save(' review ');
    expect(screen.getByRole('alert')).toHaveTextContent('already exists');
    expect(stored().templates).toHaveLength(1);
  });

  it('keeps more than eight entries and re-reads before mutations and reopening', () => {
    render(<PromptTemplates prompt={prompt} onLoad={vi.fn()} />);
    open();
    const other = Array.from({ length: 10 }, (_, i) => ({
      name: `Other ${i}`,
      prompt: 'external',
    }));
    localStorage.setItem(key, JSON.stringify({ version: 1, templates: other }));
    save('Mine');
    expect(stored().templates).toHaveLength(11);
    localStorage.setItem(
      key,
      JSON.stringify({ version: 1, templates: [{ name: 'Newest', prompt }] }),
    );
    open();
    open();
    expect(
      screen.getByRole('button', { name: 'Load Newest' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load Mine' }),
    ).not.toBeInTheDocument();
  });

  it('closes and discards displayed account state when the user changes', () => {
    const view = render(<PromptTemplates prompt={prompt} onLoad={vi.fn()} />);
    open();
    save('Private');
    userId = 'user-2';
    view.rerender(<PromptTemplates prompt="second account" onLoad={vi.fn()} />);
    expect(screen.queryByText('Private')).not.toBeInTheDocument();
    open();
    expect(screen.getByText('No saved templates.')).toBeInTheDocument();
    save('Second');
    expect(stored().templates).toEqual([{ name: 'Private', prompt }]);
  });

  it.each([
    '{bad',
    '{"version":2,"templates":[]}',
    '{"version":1,"templates":[{"name":"X","prompt":5}]}',
  ])('reports malformed storage without overwriting it: %s', (raw) => {
    localStorage.setItem(key, raw);
    render(<PromptTemplates prompt={prompt} onLoad={vi.fn()} />);
    open();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read');
    save('New');
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was saved');
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it('reports failed writes without showing a save or deletion as successful', () => {
    render(<PromptTemplates prompt={prompt} onLoad={vi.fn()} />);
    open();
    save('Existing');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    save('Failed');
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was saved');
    expect(
      screen.queryByRole('button', { name: 'Load Failed' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Existing' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was deleted');
    expect(
      screen.getByRole('button', { name: 'Load Existing' }),
    ).toBeInTheDocument();
  });

  it('does not load stale deleted text and handles blocked reads', () => {
    const onLoad = vi.fn();
    render(<PromptTemplates prompt={prompt} onLoad={onLoad} />);
    open();
    save('Removed');
    localStorage.removeItem(key);
    fireEvent.click(screen.getByRole('button', { name: 'Load Removed' }));
    expect(onLoad).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('no longer exists');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    open();
    open();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read');
  });
});
