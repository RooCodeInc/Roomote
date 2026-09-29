import {
  canDropSessionBoardCard,
  getSessionBoardDropStatus,
  getSessionBoardKeyboardTarget,
} from './session-board-dnd';

describe('session board drag-and-drop rules', () => {
  it('allows only managed cards to move between manual status columns', () => {
    expect(canDropSessionBoardCard('active', 'ready', true)).toBe(true);
    expect(canDropSessionBoardCard('ready', 'done', true)).toBe(true);
    expect(canDropSessionBoardCard('ready', 'ready', true)).toBe(false);
    expect(canDropSessionBoardCard('ready', 'active', true)).toBe(false);
    expect(canDropSessionBoardCard('ready', 'done', false)).toBe(false);
    expect(getSessionBoardDropStatus('active')).toBeNull();
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
});
