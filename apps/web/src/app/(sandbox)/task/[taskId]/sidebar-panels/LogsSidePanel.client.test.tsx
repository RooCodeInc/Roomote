import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';

const { useLogFilesMock, useMultiplexedTailLogsMock } = vi.hoisted(() => ({
  useLogFilesMock: vi.fn(),
  useMultiplexedTailLogsMock: vi.fn(),
}));

vi.mock('next/dynamic', () => ({
  default: () => () => null,
}));

vi.mock('@/components/system', () => ({
  BasicTooltip: ({ children }: { children: ReactNode }) => children,
  Button: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  ChevronDown: () => null,
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  Logs: () => null,
  Trash2: () => null,
}));

vi.mock('../hooks', () => ({
  useLogFiles: useLogFilesMock,
  useMultiplexedTailLogs: useMultiplexedTailLogsMock,
}));

vi.mock('./SidePanelHeader', () => ({
  SidePanelHeader: ({
    actions,
    titleAdornment,
  }: {
    actions?: ReactNode;
    titleAdornment?: ReactNode;
  }) => (
    <header>
      {titleAdornment}
      {actions}
    </header>
  ),
}));

import { LogsSidePanel } from './LogsSidePanel';

describe('LogsSidePanel', () => {
  const clearMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useMultiplexedTailLogsMock.mockReturnValue({
      clear: clearMock,
      error: null,
      getLines: vi.fn().mockReturnValue([]),
    });
  });

  it('gives the clear button an accessible name and clears only the selected file', async () => {
    useLogFilesMock.mockReturnValue([
      { filePath: '/tmp/setup.log', label: 'Setup' },
      { filePath: '/tmp/build.log', label: 'Build' },
    ]);

    render(<LogsSidePanel active onClose={vi.fn()} />);

    const clearButton = await screen.findByRole('button', {
      name: 'Clear logs',
    });
    fireEvent.click(clearButton);

    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(clearMock).toHaveBeenCalledWith('/tmp/setup.log');
  });

  it('does not render a clear button when no logfile is selected', async () => {
    useLogFilesMock.mockReturnValue([]);

    render(<LogsSidePanel active onClose={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Clear logs' }),
      ).not.toBeInTheDocument();
    });
    expect(clearMock).not.toHaveBeenCalled();
  });
});
