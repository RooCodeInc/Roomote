import { shouldSteerQueuedMessageOnEnter } from './enter-steer-utils';

describe('shouldSteerQueuedMessageOnEnter', () => {
  const baseInput = {
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    prompt: '',
    hasEnabledSubmitButton: false,
    hasClient: true,
    readOnly: false,
    canSteerQueuedMessages: true,
    queuedMessagesCount: 1,
    steeringInFlight: false,
  } as const;

  it('returns true for plain Enter on empty prompt when queued messages exist', () => {
    expect(shouldSteerQueuedMessageOnEnter(baseInput)).toBe(true);
  });

  it('returns false when there are no queued messages', () => {
    expect(
      shouldSteerQueuedMessageOnEnter({
        ...baseInput,
        queuedMessagesCount: 0,
      }),
    ).toBe(false);
  });

  it('returns false when prompt has content', () => {
    expect(
      shouldSteerQueuedMessageOnEnter({
        ...baseInput,
        prompt: 'hello',
      }),
    ).toBe(false);
  });

  it('returns false when submit is available for the current form state', () => {
    expect(
      shouldSteerQueuedMessageOnEnter({
        ...baseInput,
        hasEnabledSubmitButton: true,
      }),
    ).toBe(false);
  });

  it('returns true when queued steering is allowed', () => {
    expect(shouldSteerQueuedMessageOnEnter(baseInput)).toBe(true);
  });

  it('returns false when queued steering is not allowed in the current task phase', () => {
    expect(
      shouldSteerQueuedMessageOnEnter({
        ...baseInput,
        canSteerQueuedMessages: false,
      }),
    ).toBe(false);
  });

  it('returns false when modifier keys are used', () => {
    expect(
      shouldSteerQueuedMessageOnEnter({
        ...baseInput,
        shiftKey: true,
      }),
    ).toBe(false);
    expect(
      shouldSteerQueuedMessageOnEnter({
        ...baseInput,
        ctrlKey: true,
      }),
    ).toBe(false);
    expect(
      shouldSteerQueuedMessageOnEnter({
        ...baseInput,
        metaKey: true,
      }),
    ).toBe(false);
  });
});
