import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PromptLibraryMenu } from './PromptLibraryMenu';

let currentUserId = 'user-1';

const { mockToastSuccess } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess },
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => ({ userId: currentUserId }),
}));

vi.mock('@/components/system', async () => {
  const actual = await vi.importActual<typeof import('@/components/system')>(
    '@/components/system',
  );

  return {
    ...actual,
    DropdownMenu: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
      children,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
    }: {
      children: React.ReactNode;
      disabled?: boolean;
      onSelect?: () => void;
    }) => (
      <button type="button" disabled={disabled} onClick={onSelect}>
        {children}
      </button>
    ),
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
      <span>{children}</span>
    ),
    DropdownMenuSeparator: () => <hr />,
  };
});

describe('PromptLibraryMenu', () => {
  beforeEach(() => {
    currentUserId = 'user-1';
    window.localStorage.clear();
    mockToastSuccess.mockReset();
  });

  it('saves the current prompt for the signed-in user', async () => {
    render(
      <PromptLibraryMenu
        promptText="  Review this pull request  "
        onSelectPrompt={() => {}}
      />,
    );

    fireEvent.click(await screen.findByText('Save current prompt'));

    await waitFor(() => {
      expect(
        JSON.parse(
          window.localStorage.getItem('roomote-saved-prompts:v1:user-1') ??
            '[]',
        ),
      ).toEqual([
        expect.objectContaining({ text: 'Review this pull request' }),
      ]);
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Prompt saved');
  });

  it('loads a saved prompt into the task composer', async () => {
    window.localStorage.setItem(
      'roomote-saved-prompts:v1:user-1',
      JSON.stringify([
        { id: 'prompt-1', text: 'Run the release checklist', savedAt: 1 },
      ]),
    );
    const onSelectPrompt = vi.fn();

    render(<PromptLibraryMenu promptText="" onSelectPrompt={onSelectPrompt} />);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Prompts 1' }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(await screen.findByText('Run the release checklist'));

    expect(onSelectPrompt).toHaveBeenCalledWith('Run the release checklist');
  });

  it('recovers from malformed saved prompt data', async () => {
    window.localStorage.setItem('roomote-saved-prompts:v1:user-1', '{not-json');

    render(<PromptLibraryMenu promptText="" onSelectPrompt={() => {}} />);

    expect(
      await screen.findByText(
        'Save instructions you want to reuse across tasks.',
      ),
    ).toBeInTheDocument();
  });

  it('does not expose prompts while switching users', async () => {
    window.localStorage.setItem(
      'roomote-saved-prompts:v1:user-1',
      JSON.stringify([{ id: 'prompt-1', text: 'Private prompt', savedAt: 1 }]),
    );
    const { rerender } = render(
      <PromptLibraryMenu promptText="" onSelectPrompt={() => {}} />,
    );

    expect(await screen.findByText('Private prompt')).toBeInTheDocument();

    currentUserId = 'user-2';
    rerender(<PromptLibraryMenu promptText="" onSelectPrompt={() => {}} />);

    expect(screen.queryByText('Private prompt')).not.toBeInTheDocument();
    expect(
      await screen.findByText(
        'Save instructions you want to reuse across tasks.',
      ),
    ).toBeInTheDocument();
  });
});
