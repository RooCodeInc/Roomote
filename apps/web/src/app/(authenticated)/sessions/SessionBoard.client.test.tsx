import { render, waitFor } from '@testing-library/react';
import type { HTMLAttributes, ReactNode } from 'react';

const motionState = vi.hoisted(() => ({
  reducedMotion: false,
  statusMutation: { isPending: false, mutate: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/sessions/use-session-status-mutation', () => ({
  useSessionStatusMutation: () => motionState.statusMutation,
}));

vi.mock('motion/react', async () => {
  const { createElement, forwardRef } = await import('react');

  type MockMotionProps = {
    children?: ReactNode;
    initial?: unknown;
    animate?: unknown;
    transition?: unknown;
    exit?: unknown;
    layout?: unknown;
    layoutId?: string;
    onAnimationComplete?: unknown;
  } & HTMLAttributes<HTMLElement>;

  const mockMotionElement = (tag: 'div' | 'section') => {
    const MotionTag = tag;

    return forwardRef<HTMLElement, MockMotionProps>(
      (
        {
          children,
          initial: _initial,
          animate,
          transition: _transition,
          exit: _exit,
          layout,
          layoutId,
          onAnimationComplete: _onAnimationComplete,
          ...props
        },
        ref,
      ) =>
        createElement(
          MotionTag,
          {
            ...props,
            ref: ref as never,
            'data-motion-animate': JSON.stringify(animate),
            'data-motion-layout': String(layout ?? ''),
            'data-motion-layout-id': layoutId,
          },
          children,
        ),
    );
  };

  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    LayoutGroup: ({ children }: { children: ReactNode }) => children,
    MotionConfig: ({ children }: { children: ReactNode }) => children,
    motion: {
      div: mockMotionElement('div'),
      section: mockMotionElement('section'),
    },
    useReducedMotion: () => motionState.reducedMotion,
  };
});

import {
  SessionBoard,
  SessionBoardCard,
  SessionBoardColumn,
} from './SessionBoard';
import type { SessionBoardColumn as SessionBoardColumnStatus } from '@roomote/types';
import { announceSessionBoardMove } from '@/components/sessions/session-board-motion';

function renderBoard(
  columns: Partial<Record<SessionBoardColumnStatus, string[]>>,
) {
  return (
    <SessionBoard>
      {Object.entries(columns).map(([column, sessionIds]) => (
        <SessionBoardColumn
          key={column}
          column={column as SessionBoardColumnStatus}
          label={column}
          count={sessionIds.length}
        >
          {sessionIds.map((sessionId) => (
            <SessionBoardCard
              key={sessionId}
              sessionId={sessionId}
              column={column as SessionBoardColumnStatus}
              title={sessionId}
            >
              <a href={`/sessions/${sessionId}`}>{sessionId}</a>
            </SessionBoardCard>
          ))}
        </SessionBoardColumn>
      ))}
    </SessionBoard>
  );
}

function getCard(container: HTMLElement, sessionId: string) {
  return container.querySelector(
    `[data-session-board-card-id="${sessionId}"]`,
  ) as HTMLElement;
}

function getAnimation(card: HTMLElement) {
  return JSON.parse(
    card
      .querySelector('[data-motion-animate]')!
      .getAttribute('data-motion-animate')!,
  ) as {
    y: number | number[];
    scale: number | number[];
    boxShadow: string | string[];
  };
}

function getFlightLayer(card: HTMLElement) {
  return card.querySelector('[data-session-board-flight]') as HTMLElement;
}

describe('SessionBoard motion', () => {
  beforeEach(() => {
    motionState.reducedMotion = false;
  });

  it('animates only a card that changed columns with a curved lift and shadow', async () => {
    const { container, rerender } = render(
      renderBoard({ active: ['moving', 'staying'] }),
    );

    expect(getFlightLayer(getCard(container, 'moving'))).toHaveAttribute(
      'data-session-board-flight',
      'resting',
    );
    expect(getAnimation(getCard(container, 'moving')).scale).toBe(1);

    rerender(renderBoard({ active: ['staying'], ready: ['moving'] }));

    await waitFor(() => {
      expect(getFlightLayer(getCard(container, 'moving'))).toHaveAttribute(
        'data-session-board-flight',
        'active',
      );
    });
    expect(getFlightLayer(getCard(container, 'staying'))).toHaveAttribute(
      'data-session-board-flight',
      'resting',
    );

    const animation = getAnimation(getCard(container, 'moving'));
    expect(animation.y).toEqual([0, -7, -18, -8, 0]);
    expect(animation.scale).toEqual([1, 1.05, 1.1, 1.04, 1]);
    expect(animation.boxShadow[0]).toContain('0 0 0 0');
    expect(animation.boxShadow[2]).toContain('36px 72px');
    expect(animation.boxShadow.at(-1)).toContain('0 0 0 0');
  });

  it('keeps a moved card at rest when reduced motion is preferred', async () => {
    motionState.reducedMotion = true;
    const { container, rerender } = render(renderBoard({ active: ['moving'] }));

    rerender(renderBoard({ ready: ['moving'] }));

    await waitFor(() => {
      expect(getFlightLayer(getCard(container, 'moving'))).toHaveAttribute(
        'data-session-board-flight',
        'resting',
      );
    });
    expect(getAnimation(getCard(container, 'moving'))).toMatchObject({
      y: 0,
      scale: 1,
      boxShadow: '0 0 0 0 rgba(0, 0, 0, 0)',
    });
  });

  it('consumes a status-move intent after the board shell remounts', async () => {
    const firstBoard = render(renderBoard({ active: ['moving'] }));
    announceSessionBoardMove('moving', 'ready');
    firstBoard.unmount();

    const { container } = render(renderBoard({ ready: ['moving'] }));

    await waitFor(() => {
      expect(getFlightLayer(getCard(container, 'moving'))).toHaveAttribute(
        'data-session-board-flight',
        'active',
      );
    });
  });
});
