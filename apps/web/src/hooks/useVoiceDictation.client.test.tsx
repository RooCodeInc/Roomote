import { act, renderHook } from '@testing-library/react';

import { DICTATION_END_GRACE_MS, useVoiceDictation } from './useVoiceDictation';

class FakeSpeechRecognition extends EventTarget {
  static instance: FakeSpeechRecognition;
  continuous = false;
  interimResults = false;
  lang = '';
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  onresult: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;

  constructor() {
    super();
    FakeSpeechRecognition.instance = this;
  }
}

describe('useVoiceDictation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: FakeSpeechRecognition,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, 'SpeechRecognition');
  });

  it('keeps desktop dictation listening during the unexpected-end grace window', () => {
    const { result } = renderHook(() =>
      useVoiceDictation({ onTranscript: vi.fn() }),
    );

    act(() => result.current.toggle());
    act(() => FakeSpeechRecognition.instance.onstart?.());
    expect(result.current.isRecording).toBe(true);

    act(() => FakeSpeechRecognition.instance.onend?.());
    act(() => vi.advanceTimersByTime(100));
    expect(FakeSpeechRecognition.instance.start).toHaveBeenCalledTimes(2);
    expect(result.current.isRecording).toBe(true);

    act(() => vi.advanceTimersByTime(DICTATION_END_GRACE_MS - 100));
    expect(FakeSpeechRecognition.instance.abort).toHaveBeenCalledTimes(1);
    expect(result.current.isRecording).toBe(false);
  });

  it('cancels the grace restart when dictation is explicitly stopped', () => {
    const { result } = renderHook(() =>
      useVoiceDictation({ onTranscript: vi.fn() }),
    );

    act(() => result.current.toggle());
    act(() => FakeSpeechRecognition.instance.onstart?.());
    act(() => FakeSpeechRecognition.instance.onend?.());
    act(() => result.current.stop());
    act(() => vi.runAllTimers());

    expect(FakeSpeechRecognition.instance.start).toHaveBeenCalledTimes(1);
    expect(result.current.isRecording).toBe(false);
  });
});
