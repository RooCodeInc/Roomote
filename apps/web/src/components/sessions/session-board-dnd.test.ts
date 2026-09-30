import {
  canDropSessionBoardCard,
  getSessionBoardDropStatus,
  getSessionBoardKeyboardTarget,
  sessionBoardCollisionDetection,
  sessionBoardKeyboardCoordinates,
} from './session-board-dnd';

describe('session board drag-and-drop rules', () => {
  it('allows only managed cards to move between manual status columns', () => {
    expect(canDropSessionBoardCard('active', 'ready', true)).toBe(true);
    expect(canDropSessionBoardCard('ready', 'done', true)).toBe(true);
    expect(canDropSessionBoardCard('ready', 'ready', true)).toBe(true);
    expect(canDropSessionBoardCard('ready', 'active', true)).toBe(true);
    expect(canDropSessionBoardCard('ready', 'done', false)).toBe(false);
    expect(getSessionBoardDropStatus('active')).toBe('active');
    expect(getSessionBoardDropStatus('done')).toBe('done');
  });

  it('moves through manual statuses with either board axis', () => {
    expect(getSessionBoardKeyboardTarget('active', 'ArrowRight')).toBe(
      'needs_input',
    );
    expect(getSessionBoardKeyboardTarget('active', 'ArrowLeft')).toBeNull();
    expect(getSessionBoardKeyboardTarget('needs_input', 'ArrowDown')).toBe(
      'blocked',
    );
    expect(getSessionBoardKeyboardTarget('ready', 'ArrowUp')).toBe('blocked');
    expect(getSessionBoardKeyboardTarget('done', 'ArrowDown')).toBeNull();
    expect(getSessionBoardKeyboardTarget('ready', 'Enter')).toBeNull();
  });

  it('uses the pointer lane at populated and empty-lane edges', () => {
    const rect = (left: number) => ({
      bottom: 500,
      height: 500,
      left,
      right: left + 100,
      top: 0,
      width: 100,
    });
    const args = {
      droppableContainers: [{ id: 'active' }, { id: 'ready' }, { id: 'done' }],
      droppableRects: new Map([
        ['active', rect(0)],
        ['ready', rect(120)],
        ['done', rect(240)],
      ]),
      pointerCoordinates: { x: 1, y: 499 },
    } as unknown as Parameters<typeof sessionBoardCollisionDetection>[0];

    expect(sessionBoardCollisionDetection(args).map(({ id }) => id)).toEqual([
      'active',
    ]);

    args.pointerCoordinates = { x: 339, y: 1 };
    expect(sessionBoardCollisionDetection(args).map(({ id }) => id)).toEqual([
      'done',
    ]);
  });

  it('uses the current lane under the keyboard drag for repeated moves', () => {
    const context = {
      draggableNodes: new Map([
        [
          'session-1',
          {
            data: {
              current: {
                column: 'active',
                canManage: true,
                title: 'Session 1',
              },
            },
          },
        ],
      ]),
      droppableRects: new Map([
        ['needs_input', { left: 10, top: 20, width: 100, height: 50 }],
        ['blocked', { left: 130, top: 20, width: 100, height: 50 }],
      ]),
      // Collision detection can report this before the first keyboard key.
      over: { id: 'needs_input' },
    } as unknown as Parameters<
      typeof sessionBoardKeyboardCoordinates
    >[1]['context'];

    const firstMove = sessionBoardKeyboardCoordinates(
      new KeyboardEvent('keydown', { code: 'ArrowRight' }),
      {
        active: 'session-1',
        currentCoordinates: { x: 0, y: 0 },
        context,
      },
    );
    expect(firstMove).toMatchObject({ x: 60, y: 45 });

    context.over = { id: 'needs_input' } as typeof context.over;
    const secondMove = sessionBoardKeyboardCoordinates(
      new KeyboardEvent('keydown', { code: 'ArrowRight' }),
      {
        active: 'session-1',
        currentCoordinates: firstMove ?? { x: 0, y: 0 },
        context,
      },
    );
    expect(secondMove).toMatchObject({ x: 180, y: 45 });
  });
});
