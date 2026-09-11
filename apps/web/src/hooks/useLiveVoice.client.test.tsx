import { act, renderHook } from '@testing-library/react';

import { useLiveVoice } from './useLiveVoice';

const { createLiveSessionMutate, cleanTranscriptMutate, playVoiceCue } =
  vi.hoisted(() => ({
    createLiveSessionMutate: vi.fn(),
    cleanTranscriptMutate: vi.fn(),
    playVoiceCue: vi.fn(),
  }));

vi.mock('@/lib/voice-cues', () => ({ playVoiceCue }));

vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({
    voice: {
      createLiveSession: { mutate: createLiveSessionMutate },
      cleanTranscript: { mutate: cleanTranscriptMutate },
    },
  }),
}));

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  sent: string[] = [];

  send(value: string) {
    this.sent.push(value);
  }

  close() {
    this.readyState = 'closed';
  }

  emit(message: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(message) }),
    );
  }
}

class FakePeer extends EventTarget {
  static instance: FakePeer;
  readonly channel = new FakeDataChannel();
  iceGatheringState: RTCIceGatheringState = 'complete';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescription | null = null;

  constructor() {
    super();
    FakePeer.instance = this;
  }

  addTrack() {}
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: 'offer-sdp' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description as RTCSessionDescription;
  }
  async setRemoteDescription() {
    this.channel.emit({ type: 'session.started' });
  }
  close() {}

  setConnectionState(connectionState: RTCPeerConnectionState) {
    this.connectionState = connectionState;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

const stopTrack = vi.fn();
const fakeStream = {
  getAudioTracks: () => [{ stop: stopTrack }],
  getTracks: () => [{ stop: stopTrack }],
};

describe('useLiveVoice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    createLiveSessionMutate.mockResolvedValue({
      sessionId: 'live_123',
      sdp: 'answer-sdp',
    });
    cleanTranscriptMutate.mockImplementation(
      async ({ text }: { text: string }) => ({ text: `${text}.` }),
    );
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    vi.stubGlobal(
      'Audio',
      class {
        autoplay = false;
        srcObject: MediaProvider | null = null;
        play = vi.fn().mockResolvedValue(undefined);
        pause = vi.fn();
      },
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream) },
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('delegates cleaned transcript text to Fast and returns Fast output to GPT-Live', async () => {
    const onUtterance = vi.fn();
    const { result } = renderHook(() => useLiveVoice({ onUtterance }));

    await act(async () => result.current.start());

    expect(createLiveSessionMutate).toHaveBeenCalledWith({ sdp: 'offer-sdp' });
    expect(result.current.status).toBe('listening');

    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'Check the ',
        start_ms: 100,
        end_ms: 200,
      });
      FakePeer.instance.channel.emit({
        type: 'session.delegation.created',
        delegation: { id: 'item_123', target: 'client' },
      });
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'build status',
        start_ms: 200,
        end_ms: 400,
      });
      vi.advanceTimersByTime(250);
    });
    await act(async () => {});

    expect(cleanTranscriptMutate).toHaveBeenCalledWith({
      text: 'Check the build status',
    });
    expect(onUtterance).toHaveBeenCalledWith(
      'Check the build status.',
      'item_123',
    );

    act(() =>
      result.current.speak(
        'See [the result](https://example.com).',
        'item_123',
      ),
    );
    expect(
      FakePeer.instance.channel.sent.map((value) => JSON.parse(value)),
    ).toContainEqual(
      expect.objectContaining({
        type: 'session.commentary.append',
        delegation_id: 'item_123',
        content: 'See the result.',
      }),
    );
  });

  it('releases handshake resources immediately when voice is ended', async () => {
    let finishHandshake:
      | ((value: { sessionId: string; sdp: string }) => void)
      | undefined;
    createLiveSessionMutate.mockReturnValueOnce(
      new Promise((resolve) => {
        finishHandshake = resolve;
      }),
    );
    const { result } = renderHook(() => useLiveVoice({ onUtterance: vi.fn() }));

    let starting!: Promise<void>;
    act(() => {
      starting = result.current.start();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(createLiveSessionMutate).toHaveBeenCalled(),
      );
    });

    act(() => result.current.stop());
    expect(stopTrack).toHaveBeenCalled();
    expect(FakePeer.instance.channel.readyState).toBe('closed');

    await act(async () => {
      finishHandshake?.({ sessionId: 'live_123', sdp: 'answer-sdp' });
      await starting;
    });
    expect(result.current.active).toBe(false);
  });

  it('falls back to the raw transcript when cleanup fails', async () => {
    cleanTranscriptMutate.mockRejectedValue(new Error('offline'));
    const onUtterance = vi.fn();
    const { result } = renderHook(() => useLiveVoice({ onUtterance }));

    await act(async () => result.current.start());
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.delegation.created',
        delegation: { id: 'item_123', target: 'client' },
      });
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'um check the the build',
        start_ms: 0,
        end_ms: 400,
      });
      vi.advanceTimersByTime(250);
    });
    await act(async () => {});

    expect(onUtterance).toHaveBeenCalledWith(
      'um check the the build',
      'item_123',
    );
  });

  it('drops an utterance whose cleanup finishes after voice is ended', async () => {
    let finishCleanup: (value: { text: string }) => void = () => undefined;
    cleanTranscriptMutate.mockImplementation(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    const onUtterance = vi.fn();
    const { result } = renderHook(() => useLiveVoice({ onUtterance }));

    await act(async () => result.current.start());
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.delegation.created',
        delegation: { id: 'item_123', target: 'client' },
      });
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'never mind',
        start_ms: 0,
        end_ms: 400,
      });
      vi.advanceTimersByTime(250);
    });
    act(() => result.current.stop());
    await act(async () => {
      finishCleanup({ text: 'Never mind.' });
    });

    expect(onUtterance).not.toHaveBeenCalled();
  });

  it('plays a cue when the conversation opens and when it closes', async () => {
    const { result } = renderHook(() => useLiveVoice({ onUtterance: vi.fn() }));

    await act(async () => result.current.start());
    expect(playVoiceCue).toHaveBeenCalledWith('start');

    act(() => result.current.stop());
    expect(playVoiceCue).toHaveBeenCalledWith('stop');
  });

  it.each(['failed', 'closed'] as const)(
    'ends and releases an active conversation when the peer connection is %s',
    async (connectionState) => {
      const onSpokenTurn = vi.fn();
      const { result } = renderHook(() =>
        useLiveVoice({ onUtterance: vi.fn(), onSpokenTurn }),
      );

      await act(async () => result.current.start());
      const peer = FakePeer.instance;
      act(() => {
        peer.channel.emit({
          type: 'session.output_transcript.delta',
          delta: 'The call is ending.',
        });
      });

      act(() => peer.setConnectionState(connectionState));

      expect(result.current.active).toBe(false);
      expect(result.current.status).toBe('idle');
      expect(result.current.startedAt).toBeNull();
      expect(stopTrack).toHaveBeenCalledTimes(1);
      expect(peer.channel.readyState).toBe('closed');
      expect(onSpokenTurn).toHaveBeenCalledWith('The call is ending.');
      expect(playVoiceCue).toHaveBeenLastCalledWith('stop');

      peer.channel.dispatchEvent(new Event('close'));
      expect(stopTrack).toHaveBeenCalledTimes(1);
      expect(playVoiceCue).toHaveBeenCalledTimes(2);
    },
  );

  it('allows a disconnected peer to recover, then ends it after the grace period', async () => {
    const { result } = renderHook(() => useLiveVoice({ onUtterance: vi.fn() }));

    await act(async () => result.current.start());
    const peer = FakePeer.instance;

    act(() => {
      peer.setConnectionState('disconnected');
      vi.advanceTimersByTime(2_999);
      peer.setConnectionState('connected');
      vi.advanceTimersByTime(1);
    });
    expect(result.current.active).toBe(true);
    expect(stopTrack).not.toHaveBeenCalled();

    act(() => {
      peer.setConnectionState('disconnected');
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.active).toBe(false);
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('ignores terminal events from an old peer after a manual restart', async () => {
    const { result } = renderHook(() => useLiveVoice({ onUtterance: vi.fn() }));

    await act(async () => result.current.start());
    const oldPeer = FakePeer.instance;
    act(() => oldPeer.setConnectionState('failed'));

    await act(async () => result.current.start());
    const restartedPeer = FakePeer.instance;
    expect(restartedPeer).not.toBe(oldPeer);
    expect(result.current.active).toBe(true);

    act(() => {
      oldPeer.setConnectionState('closed');
      oldPeer.channel.dispatchEvent(new Event('close'));
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.active).toBe(true);
    expect(restartedPeer.channel.readyState).toBe('open');
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
  it('stays quiet for a silent stop and for an aborted handshake', async () => {
    let finishHandshake: (value: {
      sessionId: string;
      sdp: string;
    }) => void = () => undefined;
    createLiveSessionMutate.mockImplementationOnce(
      () =>
        new Promise<{ sessionId: string; sdp: string }>((resolve) => {
          finishHandshake = resolve;
        }),
    );
    const { result } = renderHook(() => useLiveVoice({ onUtterance: vi.fn() }));

    // Ending while still connecting: nothing was announced, so no closing cue.
    let starting: Promise<void> = Promise.resolve();
    await act(async () => {
      starting = result.current.start();
      await Promise.resolve();
    });
    act(() => result.current.stop());
    await act(async () => {
      finishHandshake({ sessionId: 'live_123', sdp: 'answer-sdp' });
      await starting;
    });
    expect(playVoiceCue).not.toHaveBeenCalled();

    // A handoff to a new Session ends silently.
    await act(async () => result.current.start());
    playVoiceCue.mockClear();
    act(() => result.current.stop({ silent: true }));
    expect(playVoiceCue).not.toHaveBeenCalled();
  });

  it('records small talk GPT-Live handled itself as a heard turn, and what GPT-Live said as a spoken turn', async () => {
    const onUtterance = vi.fn();
    const onHeardTurn = vi.fn();
    const onSpokenTurn = vi.fn();
    const { result } = renderHook(() =>
      useLiveVoice({ onUtterance, onHeardTurn, onSpokenTurn }),
    );

    await act(async () => result.current.start());
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'Thanks, that ',
        start_ms: 0,
        end_ms: 300,
      });
      vi.advanceTimersByTime(1_000);
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'looks right',
        start_ms: 300,
        end_ms: 600,
      });
      vi.advanceTimersByTime(1_499);
    });
    expect(onHeardTurn).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onHeardTurn).toHaveBeenCalledWith('Thanks, that looks right');
    expect(onUtterance).not.toHaveBeenCalled();

    // GPT-Live answers on its own; its words are recorded once it goes quiet.
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.output_transcript.delta',
        delta: 'Glad to ',
      });
      FakePeer.instance.channel.emit({
        type: 'session.output_transcript.delta',
        delta: 'hear it.',
      });
      vi.advanceTimersByTime(1_200);
    });
    expect(onSpokenTurn).toHaveBeenCalledWith('Glad to hear it.');

    // A delegation made while the next request was being spoken, arriving
    // before that request's transcript, is its delegation: the request must
    // reach Fast.
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.delegation.created',
        offset_ms: 5_900,
        delegation: { id: 'item_next', target: 'client' },
      });
    });
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'Now check the build',
        start_ms: 5_000,
        end_ms: 5_400,
      });
      vi.advanceTimersByTime(250);
    });
    await act(async () => {});
    expect(onUtterance).toHaveBeenCalledWith(
      'Now check the build.',
      'item_next',
    );
    expect(onHeardTurn).toHaveBeenCalledTimes(1);
  });

  it('drops a delegation that is never followed by speech, so it cannot attach to a later request', async () => {
    const onUtterance = vi.fn();
    const onHeardTurn = vi.fn();
    const { result } = renderHook(() =>
      useLiveVoice({ onUtterance, onHeardTurn }),
    );

    await act(async () => result.current.start());
    // A late delegation for speech that was already flushed as small talk.
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.delegation.created',
        offset_ms: 2_000,
        delegation: { id: 'item_stale', target: 'client' },
      });
      vi.advanceTimersByTime(3_000);
    });

    // The next thing said is small talk again: it is recorded as heard, not
    // sent to Fast under the stale delegation.
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'Cool, thanks',
        start_ms: 8_000,
        end_ms: 8_400,
      });
      vi.advanceTimersByTime(1_500);
    });
    await act(async () => {});
    expect(onHeardTurn).toHaveBeenCalledWith('Cool, thanks');
    expect(onUtterance).not.toHaveBeenCalled();
  });

  it('drops a late delegation for flushed small talk even when the next small talk starts right away', async () => {
    const onUtterance = vi.fn();
    const onHeardTurn = vi.fn();
    const { result } = renderHook(() =>
      useLiveVoice({ onUtterance, onHeardTurn }),
    );

    await act(async () => result.current.start());
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'Thanks',
        start_ms: 0,
        end_ms: 400,
      });
      vi.advanceTimersByTime(1_500);
    });
    expect(onHeardTurn).toHaveBeenCalledWith('Thanks');

    // GPT-Live's delegation for "Thanks" lands after the silence flush, and
    // the person starts talking again well inside the expiry window.
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.delegation.created',
        offset_ms: 2_200,
        delegation: { id: 'item_stale', target: 'client' },
      });
      vi.advanceTimersByTime(500);
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'Cool, thanks',
        start_ms: 2_900,
        end_ms: 3_300,
      });
      vi.advanceTimersByTime(1_500);
    });
    await act(async () => {});
    expect(onHeardTurn).toHaveBeenLastCalledWith('Cool, thanks');
    expect(onUtterance).not.toHaveBeenCalled();
  });

  it('sends a request under its own delegation, not a stale one that preceded it', async () => {
    const onUtterance = vi.fn();
    const onHeardTurn = vi.fn();
    const { result } = renderHook(() =>
      useLiveVoice({ onUtterance, onHeardTurn }),
    );

    await act(async () => result.current.start());
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.delegation.created',
        offset_ms: 2_200,
        delegation: { id: 'item_stale', target: 'client' },
      });
      vi.advanceTimersByTime(500);
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'Now check the build',
        start_ms: 2_900,
        end_ms: 3_500,
      });
      FakePeer.instance.channel.emit({
        type: 'session.delegation.created',
        offset_ms: 4_100,
        delegation: { id: 'item_fresh', target: 'client' },
      });
      vi.advanceTimersByTime(250);
    });
    await act(async () => {});
    expect(onUtterance).toHaveBeenCalledTimes(1);
    expect(onUtterance).toHaveBeenCalledWith(
      'Now check the build.',
      'item_fresh',
    );
    expect(onHeardTurn).not.toHaveBeenCalled();
  });

  it('streams both sides of the call as they are spoken', async () => {
    const onSpokenTurnDelta = vi.fn();
    const onHeardTurnDelta = vi.fn();
    const { result } = renderHook(() =>
      useLiveVoice({
        onUtterance: vi.fn(),
        onSpokenTurnDelta,
        onHeardTurnDelta,
      }),
    );

    await act(async () => result.current.start());
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.output_transcript.delta',
        delta: 'Roo-Code has ',
      });
      FakePeer.instance.channel.emit({
        type: 'session.output_transcript.delta',
        delta: 'about 452,000 lines.',
      });
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'Wow, ',
        start_ms: 0,
        end_ms: 200,
      });
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'that is a lot',
        start_ms: 200,
        end_ms: 600,
      });
    });
    expect(onSpokenTurnDelta.mock.calls.map(([text]) => text)).toEqual([
      'Roo-Code has',
      'Roo-Code has about 452,000 lines.',
    ]);
    expect(onHeardTurnDelta.mock.calls.map(([text]) => text)).toEqual([
      'Wow,',
      'Wow, that is a lot',
    ]);
  });

  it('drops sound annotations from what the person said', async () => {
    const onUtterance = vi.fn();
    const onHeardTurn = vi.fn();
    const onHeardTurnDelta = vi.fn();
    const { result } = renderHook(() =>
      useLiveVoice({ onUtterance, onHeardTurn, onHeardTurnDelta }),
    );

    await act(async () => result.current.start());
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.delegation.created',
        delegation: { id: 'item_1', target: 'client' },
      });
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: '[chuck',
        start_ms: 0,
        end_ms: 100,
      });
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'le] Can you sing your updates',
        start_ms: 100,
        end_ms: 900,
      });
      vi.advanceTimersByTime(250);
    });
    await act(async () => {});
    expect(onHeardTurnDelta).toHaveBeenLastCalledWith(
      'Can you sing your updates',
    );
    expect(cleanTranscriptMutate).toHaveBeenCalledWith({
      text: 'Can you sing your updates',
    });

    // Annotation-only speech is not a turn at all.
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: '[cough]',
        start_ms: 2_000,
        end_ms: 2_200,
      });
      vi.advanceTimersByTime(1_500);
    });
    expect(onHeardTurn).not.toHaveBeenCalled();
  });

  it('flushes the spoken turn when the person starts talking again', async () => {
    const onSpokenTurn = vi.fn();
    const { result } = renderHook(() =>
      useLiveVoice({ onUtterance: vi.fn(), onSpokenTurn }),
    );

    await act(async () => result.current.start());
    act(() => {
      FakePeer.instance.channel.emit({
        type: 'session.output_transcript.delta',
        delta: 'Roo-Code has about 452,000 lines.',
      });
      FakePeer.instance.channel.emit({
        type: 'session.input_transcript.delta',
        delta: 'Wow',
        start_ms: 0,
        end_ms: 200,
      });
    });
    expect(onSpokenTurn).toHaveBeenCalledWith(
      'Roo-Code has about 452,000 lines.',
    );
  });
});
