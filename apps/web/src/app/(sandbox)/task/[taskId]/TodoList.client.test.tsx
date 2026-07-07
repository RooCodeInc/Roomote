import { act, render, screen } from '@testing-library/react';
import type { AcpPlanTodo } from '@roomote/types';

const {
  useSandboxTodosMock,
  useIsInsideSandboxProviderMock,
  useSandboxTaskPhaseMock,
} = vi.hoisted(() => ({
  useSandboxTodosMock: vi.fn<() => AcpPlanTodo[]>(),
  useIsInsideSandboxProviderMock: vi.fn<() => boolean>(),
  useSandboxTaskPhaseMock:
    vi.fn<() => 'running' | 'waiting_for_user_input' | 'idle' | null>(),
}));

vi.mock('./hooks/SandboxProvider', () => ({
  useSandboxTodos: useSandboxTodosMock,
  useIsInsideSandboxProvider: useIsInsideSandboxProviderMock,
  useSandboxTaskPhase: useSandboxTaskPhaseMock,
}));

import { TodoList } from './TodoList';

function mockMobileViewport() {
  return vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query === '(max-width: 767px)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as MediaQueryList,
  );
}

describe('TodoList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useIsInsideSandboxProviderMock.mockReturnValue(true);
    useSandboxTaskPhaseMock.mockReturnValue('running');
  });

  it('opens populated todos by default', () => {
    useSandboxTodosMock.mockReturnValue([
      { id: '1', content: 'Inspect layout', status: 'in_progress' },
      { id: '2', content: 'Move the todo block', status: 'pending' },
      { id: '3', content: 'Verify prompt alignment', status: 'completed' },
    ]);

    render(<TodoList taskEntryKey="task-1" />);

    expect(
      screen.getByRole('button', { name: /1 of 3 to-dos done/i }),
    ).toBeVisible();
    expect(screen.getByText('Inspect layout')).toBeVisible();
    expect(screen.getByText('Move the todo block')).toBeVisible();
    expect(screen.getByText('Verify prompt alignment')).toBeVisible();
  });

  it('starts collapsed on mobile task entry', () => {
    const matchMediaSpy = mockMobileViewport();

    useSandboxTodosMock.mockReturnValue([
      { id: '1', content: 'Inspect layout', status: 'in_progress' },
      { id: '2', content: 'Move the todo block', status: 'pending' },
    ]);

    try {
      render(<TodoList taskEntryKey="task-1" />);

      expect(
        screen.getByRole('button', { name: /0 of 2 to-dos done/i }),
      ).toBeVisible();
      expect(screen.queryByText('Inspect layout')).not.toBeInTheDocument();
      expect(screen.queryByText('Move the todo block')).not.toBeInTheDocument();
    } finally {
      matchMediaSpy.mockRestore();
    }
  });

  it('keeps the todo list collapsed when mobile navigation leaves a completed task', () => {
    const matchMediaSpy = mockMobileViewport();

    try {
      useSandboxTodosMock.mockReturnValue([
        { id: '1', content: 'Inspect layout', status: 'completed' },
        { id: '2', content: 'Move the todo block', status: 'completed' },
      ]);

      const { rerender } = render(<TodoList taskEntryKey="task-1" />);

      expect(
        screen.getByRole('button', { name: /2 to-dos done/i }),
      ).toBeVisible();
      expect(screen.queryByText('Inspect layout')).not.toBeInTheDocument();

      useSandboxTodosMock.mockReturnValue([
        { id: '3', content: 'Reopen the task', status: 'in_progress' },
        { id: '4', content: 'Keep the transcript visible', status: 'pending' },
      ]);

      rerender(<TodoList taskEntryKey="task-2" />);

      expect(
        screen.getByRole('button', { name: /0 of 2 to-dos done/i }),
      ).toBeVisible();
      expect(screen.queryByText('Reopen the task')).not.toBeInTheDocument();
      expect(
        screen.queryByText('Keep the transcript visible'),
      ).not.toBeInTheDocument();
    } finally {
      matchMediaSpy.mockRestore();
    }
  });

  it('returns null outside the sandbox provider', () => {
    useIsInsideSandboxProviderMock.mockReturnValue(false);
    useSandboxTodosMock.mockReturnValue([
      { id: '1', content: 'Inspect layout', status: 'pending' },
    ]);

    const { container } = render(<TodoList taskEntryKey="task-1" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('collapses when the last todo completes, then hides it after 10 seconds', () => {
    vi.useFakeTimers();

    try {
      useSandboxTodosMock.mockReturnValue([
        { id: '1', content: 'Inspect layout', status: 'in_progress' },
        { id: '2', content: 'Move the todo block', status: 'completed' },
      ]);

      const { rerender } = render(<TodoList taskEntryKey="task-1" />);

      expect(
        screen.getByRole('button', { name: /1 of 2 to-dos done/i }),
      ).toBeVisible();
      expect(screen.getByText('Inspect layout')).toBeVisible();

      useSandboxTodosMock.mockReturnValue([
        { id: '1', content: 'Inspect layout', status: 'completed' },
        { id: '2', content: 'Move the todo block', status: 'completed' },
      ]);

      rerender(<TodoList taskEntryKey="task-1" />);

      expect(
        screen.getByRole('button', { name: /2 to-dos done/i }),
      ).toBeVisible();
      expect(screen.queryByText('Inspect layout')).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(9_000);
      });

      expect(
        screen.getByRole('button', { name: /2 to-dos done/i }),
      ).toBeVisible();

      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      expect(
        screen.queryByRole('button', { name: /2 to-dos done/i }),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not present stale unfinished todos as active when the task is idle', () => {
    useSandboxTaskPhaseMock.mockReturnValue('idle');
    useSandboxTodosMock.mockReturnValue([
      { id: '1', content: 'Inspect layout', status: 'in_progress' },
      { id: '2', content: 'Move the todo block', status: 'pending' },
    ]);

    const { container } = render(<TodoList taskEntryKey="task-1" />);

    const items = Array.from(container.querySelectorAll('li'));

    expect(items).toHaveLength(2);
    expect(items[0]?.className).toContain('text-muted-foreground/70');
    expect(items[1]?.className).toContain('text-muted-foreground/70');
  });

  it('keeps the active todo highlighted while task phase is still unknown', () => {
    useSandboxTaskPhaseMock.mockReturnValue(null);
    useSandboxTodosMock.mockReturnValue([
      { id: '1', content: 'Inspect layout', status: 'completed' },
      { id: '2', content: 'Move the todo block', status: 'pending' },
      { id: '3', content: 'Verify prompt alignment', status: 'pending' },
    ]);

    const { container } = render(<TodoList taskEntryKey="task-1" />);

    const items = Array.from(container.querySelectorAll('li'));

    expect(items).toHaveLength(3);
    expect(items[1]?.className).not.toContain('text-muted-foreground/70');
    expect(items[2]?.className).toContain('text-muted-foreground/70');
  });
});
