import { render, waitFor } from '@testing-library/react';

import { useTaskCompletionNotification } from '../use-task-completion-notification';

type NotificationPhase =
  | 'idle'
  | 'running'
  | 'waiting_for_prompt'
  | 'waiting_for_user_input'
  | undefined;

function NotificationProbe({ phase }: { phase: NotificationPhase }) {
  useTaskCompletionNotification(phase);
  return null;
}

function ResumeNotificationProbe({
  phase,
  sessionState,
}: {
  phase: NotificationPhase;
  sessionState?: string;
}) {
  useTaskCompletionNotification(phase, { sessionState });
  return null;
}

describe('useTaskCompletionNotification', () => {
  let hidden = true;
  let playMock: ReturnType<typeof vi.fn>;
  let pauseMock: ReturnType<typeof vi.fn>;
  let originalAudio: typeof Audio;

  beforeEach(() => {
    vi.clearAllMocks();

    hidden = true;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });

    document.head.innerHTML = '<link rel="icon" href="/favicon.ico" />';

    playMock = vi.fn().mockResolvedValue(undefined);
    pauseMock = vi.fn();
    originalAudio = globalThis.Audio;
    class MockAudio {
      public currentTime = 0;
      public volume = 1;

      constructor(_src?: string) {}

      public addEventListener = vi.fn();
      public play = playMock;
      public pause = pauseMock;
    }

    globalThis.Audio = MockAudio as unknown as typeof Audio;
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'hidden');
    globalThis.Audio = originalAudio;
  });

  it('plays a notification when phase transitions from running to waiting_for_user_input in the background', async () => {
    const { rerender } = render(<NotificationProbe phase="running" />);

    rerender(<NotificationProbe phase="waiting_for_user_input" />);

    await waitFor(() => {
      expect(playMock).toHaveBeenCalledTimes(1);
    });
  });

  it('plays a notification when a task finishes resuming into a ready phase in the background', async () => {
    const { rerender } = render(
      <ResumeNotificationProbe
        phase="waiting_for_prompt"
        sessionState="resuming"
      />,
    );

    rerender(
      <ResumeNotificationProbe
        phase="waiting_for_prompt"
        sessionState="interactive"
      />,
    );

    await waitFor(() => {
      expect(playMock).toHaveBeenCalledTimes(1);
    });
  });

  it('does not stack repeated hidden-tab notifications before the user returns', async () => {
    const { rerender } = render(<NotificationProbe phase="running" />);

    rerender(<NotificationProbe phase="waiting_for_user_input" />);
    rerender(<NotificationProbe phase="running" />);
    rerender(<NotificationProbe phase="waiting_for_prompt" />);

    await waitFor(() => {
      expect(playMock).toHaveBeenCalledTimes(1);
    });
  });

  it('allows a new hidden-tab notification after the page becomes visible again', async () => {
    const { rerender } = render(<NotificationProbe phase="running" />);

    rerender(<NotificationProbe phase="waiting_for_user_input" />);

    await waitFor(() => {
      expect(playMock).toHaveBeenCalledTimes(1);
    });

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));

    hidden = true;
    rerender(<NotificationProbe phase="running" />);
    rerender(<NotificationProbe phase="waiting_for_prompt" />);

    await waitFor(() => {
      expect(playMock).toHaveBeenCalledTimes(2);
    });
  });

  it('cancels any deferred background audio when the page becomes visible again', async () => {
    const { rerender } = render(<NotificationProbe phase="running" />);

    rerender(<NotificationProbe phase="waiting_for_user_input" />);

    await waitFor(() => {
      expect(playMock).toHaveBeenCalledTimes(1);
    });

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(pauseMock).toHaveBeenCalledTimes(1);
    });
  });

  it('does not play a notification when a resumed task becomes interactive in the foreground', async () => {
    hidden = false;

    const { rerender } = render(
      <ResumeNotificationProbe
        phase="waiting_for_prompt"
        sessionState="resuming"
      />,
    );

    rerender(
      <ResumeNotificationProbe
        phase="waiting_for_prompt"
        sessionState="interactive"
      />,
    );

    await waitFor(() => {
      expect(playMock).not.toHaveBeenCalled();
    });
  });
});
