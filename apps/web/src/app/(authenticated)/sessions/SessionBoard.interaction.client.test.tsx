import { act, fireEvent, render, screen } from '@testing-library/react';
import Link from 'next/link';
import type { HTMLAttributes, ReactNode } from 'react';

type DndTestProps = {
  accessibility?: {
    screenReaderInstructions: { draggable: string };
  };
  sensors?: unknown[];
  onDragStart?: (event: unknown) => void;
  onDragEnd?: (event: unknown) => void;
  onDragCancel?: (event: unknown) => void;
};

const testState = vi.hoisted(() => ({
  dndProps: null as DndTestProps | null,
  mutate: vi.fn(),
  replace: vi.fn(),
  searchParams: new URLSearchParams('view=board&status=active&before=cursor'),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useRouter: () => ({ replace: testState.replace }),
  useSearchParams: () => testState.searchParams,
}));

vi.mock('@/components/sessions/use-session-status-mutation', () => ({
  useSessionStatusMutation: () => ({
    isPending: false,
    mutate: testState.mutate,
  }),
}));

vi.mock('@dnd-kit/core', async () => {
  return {
    DndContext: ({
      children,
      ...props
    }: { children: ReactNode } & DndTestProps) => {
      testState.dndProps = props;
      return children;
    },
    KeyboardCode: {
      Down: 'ArrowDown',
      Right: 'ArrowRight',
      Left: 'ArrowLeft',
      Up: 'ArrowUp',
    },
    KeyboardSensor: function KeyboardSensor() {},
    MouseSensor: function MouseSensor() {},
    TouchSensor: function TouchSensor() {},
    closestCenter: vi.fn(),
    useSensor: vi.fn((sensor: unknown, options: unknown) => ({
      sensor,
      options,
    })),
    useSensors: vi.fn((...sensors: unknown[]) => sensors),
    useDraggable: ({ disabled }: { disabled?: boolean }) => ({
      attributes: {
        role: 'button',
        tabIndex: 0,
        'aria-disabled': disabled ?? false,
        'aria-pressed': undefined,
        'aria-roledescription': 'draggable',
        'aria-describedby': 'dnd-instructions',
      },
      isDragging: false,
      listeners: {},
      setActivatorNodeRef: vi.fn(),
      setNodeRef: vi.fn(),
      transform: null,
    }),
    useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }),
  };
});

vi.mock('motion/react', async () => {
  const { createElement, forwardRef } = await import('react');
  type MockMotionProps = HTMLAttributes<HTMLElement> & {
    animate?: unknown;
    children?: ReactNode;
    exit?: unknown;
    initial?: unknown;
    layout?: unknown;
    layoutId?: string;
    onAnimationComplete?: unknown;
    transition?: unknown;
  };

  const motionElement = (tag: 'div' | 'section') =>
    forwardRef<HTMLElement, MockMotionProps>(
      (
        {
          children,
          initial: _initial,
          animate: _animate,
          transition: _transition,
          exit: _exit,
          layout: _layout,
          layoutId: _layoutId,
          onAnimationComplete: _onAnimationComplete,
          ...props
        },
        ref,
      ) => createElement(tag, { ...props, ref: ref as never }, children),
    );

  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    LayoutGroup: ({ children }: { children: ReactNode }) => children,
    MotionConfig: ({ children }: { children: ReactNode }) => children,
    motion: { div: motionElement('div'), section: motionElement('section') },
    useReducedMotion: () => false,
  };
});

import {
  SessionBoard,
  SessionBoardCard,
  SessionBoardColumn,
} from './SessionBoard';

function renderInteractionBoard() {
  return render(
    <SessionBoard>
      <SessionBoardColumn
        column="active"
        label="active"
        count={1}
        statusFilter="active"
      >
        <SessionBoardCard
          sessionId="session-active"
          column="active"
          title="Build the board"
          canManage
        >
          <Link href="/sessions/session-active">Build the board</Link>
          <button type="button">Card action</button>
        </SessionBoardCard>
      </SessionBoardColumn>
      <SessionBoardColumn column="done" label="done" count={1}>
        <SessionBoardCard
          sessionId="session-done"
          column="done"
          title="Already done"
        >
          <Link href="/sessions/session-done">Already done</Link>
        </SessionBoardCard>
      </SessionBoardColumn>
      <SessionBoardColumn column="ready" label="ready" count={0}>
        {null}
      </SessionBoardColumn>
    </SessionBoard>,
  );
}

function activeDragEvent() {
  return {
    active: {
      id: 'session-active',
      data: {
        current: {
          column: 'active',
          canManage: true,
          title: 'Build the board',
        },
      },
    },
  };
}

describe('SessionBoard drag interaction', () => {
  beforeEach(() => {
    testState.dndProps = null;
    testState.mutate.mockReset();
    testState.replace.mockReset();
    testState.searchParams = new URLSearchParams(
      'view=board&status=active&before=cursor',
    );
  });

  it('keeps interactive content intact and exposes a keyboard-capable handle', () => {
    renderInteractionBoard();

    expect(
      screen.getByRole('button', {
        name: 'Move Build the board to another status',
      }),
    ).toHaveAttribute('data-session-board-drag-handle');
    expect(
      screen.getByRole('button', {
        name: 'Move Build the board to another status',
      }),
    ).toHaveAttribute('aria-roledescription', 'draggable');
    expect(
      testState.dndProps?.accessibility?.screenReaderInstructions.draggable,
    ).toContain('arrow keys');
    const configuredSensors = testState.dndProps?.sensors as Array<{
      sensor: { name: string };
      options: { activationConstraint?: unknown };
    }>;
    expect(configuredSensors.map(({ sensor }) => sensor.name)).toEqual([
      'MouseSensor',
      'TouchSensor',
      'KeyboardSensor',
    ]);
    expect(configuredSensors[1]?.options.activationConstraint).toEqual({
      delay: 250,
      tolerance: 5,
    });
    expect(
      screen.getByRole('link', { name: 'Build the board' }),
    ).toHaveAttribute('href', '/sessions/session-active');
    expect(
      screen.getByRole('button', { name: 'Card action' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Move Already done to another status',
      }),
    ).not.toBeInTheDocument();
  });

  it('places the count after the title and toggles the shared status filter', () => {
    renderInteractionBoard();

    const activeHeading = screen.getByRole('heading', { name: 'active' });
    expect(activeHeading.nextElementSibling).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: 'Show all sessions' }));
    expect(testState.replace).toHaveBeenCalledWith('/sessions?view=board');

    fireEvent.click(
      screen.getByRole('button', { name: 'Show only completed sessions' }),
    );
    expect(testState.replace).toHaveBeenCalledWith(
      '/sessions?view=board&status=done',
    );
  });

  it('humanizes the filter action for every board lane', () => {
    render(
      <SessionBoard>
        <SessionBoardColumn column="active" label="active" count={1}>
          {null}
        </SessionBoardColumn>
        <SessionBoardColumn column="needs_input" label="needs input" count={1}>
          {null}
        </SessionBoardColumn>
        <SessionBoardColumn column="blocked" label="blocked" count={1}>
          {null}
        </SessionBoardColumn>
        <SessionBoardColumn column="ready" label="ready" count={1}>
          {null}
        </SessionBoardColumn>
        <SessionBoardColumn column="done" label="done" count={1}>
          {null}
        </SessionBoardColumn>
      </SessionBoard>,
    );

    for (const name of [
      'Show only active sessions',
      'Show only sessions needing input',
      'Show only blocked sessions',
      'Show only ready sessions',
      'Show only completed sessions',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('shows valid targets, ignores invalid/no-op drops, and sends a valid drop to the shared mutation', () => {
    renderInteractionBoard();
    const event = activeDragEvent();

    act(() => testState.dndProps?.onDragStart?.(event));
    expect(screen.getByRole('region', { name: 'active' })).toHaveAttribute(
      'data-session-board-drop-target',
      'source',
    );
    expect(screen.getByRole('region', { name: 'done' })).toHaveAttribute(
      'data-session-board-drop-target',
      'available',
    );
    expect(screen.getByRole('region', { name: 'ready' })).toHaveTextContent(
      'Drop here to mark as ready',
    );

    act(() =>
      testState.dndProps?.onDragEnd?.({
        ...event,
        over: { id: 'active' },
      }),
    );
    expect(testState.mutate).not.toHaveBeenCalled();

    act(() => testState.dndProps?.onDragStart?.(event));
    act(() =>
      testState.dndProps?.onDragEnd?.({
        ...event,
        over: { id: 'done' },
      }),
    );
    expect(testState.mutate).toHaveBeenCalledWith({
      sessionId: 'session-active',
      status: 'done',
    });
  });

  it('cancels without changing the authoritative card or mutation state', () => {
    renderInteractionBoard();
    const event = activeDragEvent();

    act(() => testState.dndProps?.onDragStart?.(event));
    act(() => testState.dndProps?.onDragCancel?.(event));

    expect(testState.mutate).not.toHaveBeenCalled();
    expect(
      screen.getByRole('link', { name: 'Build the board' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'active' })).toHaveAttribute(
      'data-session-board-drop-target',
      'inactive',
    );
  });
});
