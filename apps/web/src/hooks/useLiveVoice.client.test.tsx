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

    expect(createLiveSessionMutate).toHaveBeenCalledWith({
      sdp: 'offer-sdp',
      mode: 'conversation',
    });
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

  it('starts a kickoff conversation and shares session-wide context', async () => {
    const { result } = renderHook(() =>
      useLiveVoice({ onUtterance: vi.fn(), mode: 'kickoff' }),
    );

    await act(async () => result.current.start());
    expect(createLiveSessionMutate).toHaveBeenCalledWith({
      sdp: 'offer-sdp',
      mode: 'kickoff',
    });

    act(() => result.current.addContext('The person asked about the build.'));
    expect(
      FakePeer.instance.channel.sent.map((value) => JSON.parse(value)),
    ).toContainEqual(
      expect.objectContaining({
        type: 'session.instructions.append',
        delegation_id: null,
        content: 'The person asked about the build.',
      }),
    );
  });
});
