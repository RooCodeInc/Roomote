'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useTRPCClient } from '@/trpc/client';
import { chunkSpeakableText, toSpeakableText } from '@/lib/voice-speech';

/**
 * Live voice conversation controller. Streams the microphone to OpenAI's
 * realtime transcription API over WebRTC (using a short-lived token minted
 * server-side), surfaces completed utterances to the caller, and plays
 * synthesized replies from the deployment's TTS endpoint. The transcription
 * model (`gpt-live-transcribe`) streams word-by-word deltas continuously and
 * has no server-side turn detection, so a local energy-based VAD watches the
 * microphone: a pause commits the audio buffer (finalizing the utterance)
 * and detected speech interrupts playback so the user can talk over a reply.
 */

const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const TTS_SAMPLE_RATE = 24_000;
/** Feed the player in ~250ms batches so playback starts almost immediately. */
const MIN_PLAYBACK_SAMPLES = TTS_SAMPLE_RATE / 4;

/**
 * Each synthesis request stays short so its first audio byte arrives fast;
 * sentences queued while a request is in flight coalesce up to this size.
 */
const TTS_CHUNK_CHARS = 400;
/** Synthesis requests kept in flight ahead of the one being played. */
const TTS_PREFETCH = 2;

const VAD_INTERVAL_MS = 50;
/** RMS above this counts as the user speaking. */
const VAD_SPEECH_RMS = 0.02;
/** A pause this long ends the utterance and commits it. */
const VAD_SILENCE_MS = 600;
/** Shorter bursts (a cough, a keyboard clack) are not worth committing. */
const VAD_MIN_SPEECH_MS = 250;

export type LiveVoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'error';

interface UseLiveVoiceOptions {
  /** Called with each completed utterance, ready to send to the agent. */
  onUtterance: (text: string) => void;
  /** Blocks starting a conversation (e.g. while the composer is busy). */
  disabled?: boolean;
}

interface UseLiveVoiceReturn {
  /** Whether a voice conversation is running. */
  active: boolean;
  status: LiveVoiceStatus;
  /** In-progress transcription of the current utterance. */
  interimTranscript: string;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  /**
   * Queue agent reply text for speech (raw markdown; it is cleaned before
   * synthesis). Calls append to whatever is already playing, so a reply can
   * be spoken sentence by sentence as it streams in.
   */
  speak: (markdown: string) => void;
  stopSpeaking: () => void;
  /**
   * Incremented each time the user talks over a reply. Callers use it to
   * drop the rest of the interrupted reply instead of resuming it later.
   */
  interruptions: number;
}

type SpeechQueueItem = {
  text: string;
  /** Prefetched synthesis response, once the request has been started. */
  response?: Promise<Response>;
};

type RealtimeServerEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
};

export function useLiveVoice({
  onUtterance,
  disabled = false,
}: UseLiveVoiceOptions): UseLiveVoiceReturn {
  const trpcClient = useTRPCClient();
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<LiveVoiceStatus>('idle');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [interruptions, setInterruptions] = useState(0);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeRef = useRef(false);
  // Bumped by every start() and stop(). An in-flight start compares its own
  // generation after each await so a stop() (or a second start()) issued
  // mid-handshake makes the stale attempt release its resources instead of
  // activating a conversation the user already cancelled.
  const startGenerationRef = useRef(0);
  const connectingRef = useRef(false);
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  // Playback state. The generation counter invalidates in-flight synthesis
  // whenever playback is interrupted, so a stale fetch can't resume talking.
  const playbackGenerationRef = useRef(0);
  const playbackAbortRef = useRef<AbortController | null>(null);
  const scheduledSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextPlaybackTimeRef = useRef(0);
  const speakingRef = useRef(false);
  const speechQueueRef = useRef<SpeechQueueItem[]>([]);
  const drainingRef = useRef(false);

  const setSpeaking = useCallback((speaking: boolean) => {
    speakingRef.current = speaking;
    setStatus((current) => {
      if (!activeRef.current) return current;
      return speaking ? 'speaking' : 'listening';
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    playbackGenerationRef.current += 1;
    playbackAbortRef.current?.abort();
    playbackAbortRef.current = null;
    speechQueueRef.current = [];
    drainingRef.current = false;

    for (const source of scheduledSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    scheduledSourcesRef.current.clear();
    nextPlaybackTimeRef.current = 0;

    if (speakingRef.current) {
      setSpeaking(false);
    }
  }, [setSpeaking]);

  /** Barge-in: the user talking over a reply silences it for good. */
  const interrupt = useCallback(() => {
    if (!speakingRef.current && speechQueueRef.current.length === 0) {
      return;
    }
    stopSpeaking();
    setInterruptions((count) => count + 1);
  }, [stopSpeaking]);

  // Local VAD state: an analyser taps the mic stream and a timer classifies
  // each 50ms window as speech or silence.
  const vadTimerRef = useRef<number | null>(null);
  const vadAnalyserRef = useRef<AnalyserNode | null>(null);
  const vadSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const vadSamplesRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const vadStateRef = useRef({
    speaking: false,
    speechStartAt: 0,
    lastVoiceAt: 0,
    hadSpeech: false,
  });

  const ensureAudioContext = useCallback(() => {
    const context =
      audioContextRef.current ??
      new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
    audioContextRef.current = context;
    void context.resume().catch(() => undefined);
    return context;
  }, []);

  /** Finalize the buffered utterance; the completed transcript follows as a
   * server event. */
  const commitUtterance = useCallback(() => {
    const channel = dataChannelRef.current;

    if (channel?.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    }
  }, []);

  const stopVad = useCallback(() => {
    if (vadTimerRef.current !== null) {
      window.clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    vadSourceRef.current?.disconnect();
    vadSourceRef.current = null;
    vadAnalyserRef.current = null;
    vadSamplesRef.current = null;
  }, []);

  const startVad = useCallback(
    (micStream: MediaStream) => {
      const context = ensureAudioContext();
      const source = context.createMediaStreamSource(micStream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      vadSourceRef.current = source;
      vadAnalyserRef.current = analyser;
      vadSamplesRef.current = new Float32Array(analyser.fftSize);
      vadStateRef.current = {
        speaking: false,
        speechStartAt: 0,
        lastVoiceAt: 0,
        hadSpeech: false,
      };

      vadTimerRef.current = window.setInterval(() => {
        const currentAnalyser = vadAnalyserRef.current;
        const samples = vadSamplesRef.current;

        if (!currentAnalyser || !samples) {
          return;
        }

        currentAnalyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
          const value = samples[i] ?? 0;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / samples.length);
        // Residual echo of the agent's own reply must not read as the user
        // interrupting, so the bar is higher while a reply is playing.
        const threshold = speakingRef.current
          ? VAD_SPEECH_RMS * 2
          : VAD_SPEECH_RMS;
        const now = Date.now();
        const state = vadStateRef.current;

        if (rms >= threshold) {
          if (!state.speaking) {
            state.speaking = true;
            state.speechStartAt = now;
            interrupt();
          }
          state.lastVoiceAt = now;
          state.hadSpeech = true;
          return;
        }

        if (state.speaking && now - state.lastVoiceAt >= VAD_SILENCE_MS) {
          state.speaking = false;
          const spokeLongEnough =
            state.lastVoiceAt - state.speechStartAt >= VAD_MIN_SPEECH_MS;

          if (state.hadSpeech && spokeLongEnough) {
            commitUtterance();
          }
          state.hadSpeech = false;
        }
      }, VAD_INTERVAL_MS);
    },
    [commitUtterance, ensureAudioContext, interrupt],
  );

  const stop = useCallback(() => {
    startGenerationRef.current += 1;
    connectingRef.current = false;
    activeRef.current = false;
    stopVad();
    stopSpeaking();
    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    setActive(false);
    setStatus('idle');
    setInterimTranscript('');
  }, [stopSpeaking, stopVad]);

  const handleServerEvent = useCallback(
    (raw: string) => {
      let event: RealtimeServerEvent;

      try {
        event = JSON.parse(raw) as RealtimeServerEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case 'input_audio_buffer.speech_started':
          interrupt();
          break;
        case 'conversation.item.input_audio_transcription.delta':
          if (event.delta) {
            setInterimTranscript((current) => current + event.delta);
          }
          break;
        case 'conversation.item.input_audio_transcription.completed': {
          setInterimTranscript('');
          const transcript = event.transcript?.trim();
          if (transcript) {
            onUtteranceRef.current(transcript);
          }
          break;
        }
        case 'error':
          setError(event.error?.message ?? 'Voice transcription error');
          break;
        default:
          break;
      }
    },
    [interrupt],
  );

  const start = useCallback(async () => {
    if (activeRef.current || connectingRef.current || disabled) {
      return;
    }

    const generation = ++startGenerationRef.current;
    const isStale = () => startGenerationRef.current !== generation;
    connectingRef.current = true;
    setError(null);
    setStatus('connecting');

    let micStream: MediaStream | null = null;
    let peer: RTCPeerConnection | null = null;
    const releaseAttempt = () => {
      peer?.close();
      micStream?.getTracks().forEach((track) => track.stop());
    };

    try {
      const token = await trpcClient.voice.createRealtimeToken.mutate();
      if (isStale()) return;

      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Echo cancellation keeps the agent's own spoken reply (played
          // through the speakers) from triggering barge-in.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (isStale()) {
        releaseAttempt();
        return;
      }

      peer = new RTCPeerConnection();
      const [audioTrack] = micStream.getAudioTracks();

      if (!audioTrack) {
        throw new Error('No microphone available');
      }

      peer.addTrack(audioTrack, micStream);

      const dataChannel = peer.createDataChannel('oai-events');
      dataChannel.onmessage = (event) => handleServerEvent(String(event.data));

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (isStale()) {
        releaseAttempt();
        return;
      }

      const response = await fetch(OPENAI_REALTIME_CALLS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.value}`,
          'content-type': 'application/sdp',
        },
        body: offer.sdp,
      });

      if (!response.ok) {
        throw new Error('Voice session handshake failed');
      }

      const answerSdp = await response.text();
      if (isStale()) {
        releaseAttempt();
        return;
      }

      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (isStale()) {
        releaseAttempt();
        return;
      }

      peerRef.current = peer;
      dataChannelRef.current = dataChannel;
      micStreamRef.current = micStream;
      connectingRef.current = false;
      activeRef.current = true;
      startVad(micStream);
      setActive(true);
      setStatus('listening');
    } catch (caught) {
      if (isStale()) {
        // A stop() already reset the hook; just drop what this attempt held.
        releaseAttempt();
        return;
      }

      releaseAttempt();
      stop();
      setStatus('error');
      setError(
        caught instanceof Error && caught.name === 'NotAllowedError'
          ? 'Microphone access was denied'
          : 'Could not start the voice conversation',
      );
    }
  }, [disabled, handleServerEvent, startVad, stop, trpcClient]);

  const schedulePcm = useCallback(
    (context: AudioContext, samples: Float32Array<ArrayBuffer>) => {
      const buffer = context.createBuffer(1, samples.length, TTS_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);

      const startAt = Math.max(
        context.currentTime,
        nextPlaybackTimeRef.current,
      );
      nextPlaybackTimeRef.current = startAt + buffer.duration;
      scheduledSourcesRef.current.add(source);
      source.onended = () => {
        scheduledSourcesRef.current.delete(source);
        if (
          scheduledSourcesRef.current.size === 0 &&
          !playbackAbortRef.current
        ) {
          setSpeaking(false);
        }
      };
      source.start(startAt);
    },
    [setSpeaking],
  );

  const fetchSpeech = useCallback(
    (text: string, signal: AbortSignal) =>
      fetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      }),
    [],
  );

  /** Stream one synthesis response into the audio scheduler. */
  const playResponse = useCallback(
    async (
      context: AudioContext,
      response: Response,
      generation: number,
    ): Promise<boolean> => {
      if (!response.ok || !response.body) {
        throw new Error('Speech synthesis failed');
      }

      const reader = response.body.getReader();
      // 16-bit samples can split across network chunks; carry the odd byte
      // over, and batch small reads so sources aren't tiny.
      let carry = new Uint8Array(0);
      let pending: Float32Array[] = [];
      let pendingSamples = 0;

      const flush = () => {
        if (pendingSamples === 0) return;
        const merged = new Float32Array(pendingSamples);
        let offset = 0;
        for (const part of pending) {
          merged.set(part, offset);
          offset += part.length;
        }
        pending = [];
        pendingSamples = 0;
        schedulePcm(context, merged);
      };

      while (true) {
        const { done, value } = await reader.read();

        if (playbackGenerationRef.current !== generation) {
          await reader.cancel().catch(() => undefined);
          return false;
        }

        if (done) {
          break;
        }

        const bytes = new Uint8Array(carry.length + value.length);
        bytes.set(carry, 0);
        bytes.set(value, carry.length);
        const usable = bytes.length - (bytes.length % 2);
        carry = bytes.slice(usable);

        if (usable === 0) {
          continue;
        }

        const ints = new Int16Array(bytes.buffer.slice(0, usable));
        const floats = new Float32Array(ints.length);
        for (let i = 0; i < ints.length; i++) {
          floats[i] = (ints[i] ?? 0) / 32_768;
        }
        pending.push(floats);
        pendingSamples += floats.length;

        if (pendingSamples >= MIN_PLAYBACK_SAMPLES) {
          flush();
        }
      }

      flush();
      return true;
    },
    [schedulePcm],
  );

  /**
   * Drain the speech queue: synthesize each item in order while keeping the
   * next few requests in flight, so the gap between sentences is playback
   * time rather than round-trip time.
   */
  const drainSpeechQueue = useCallback(() => {
    if (drainingRef.current) {
      return;
    }

    const generation = playbackGenerationRef.current;
    const abortController = new AbortController();
    playbackAbortRef.current = abortController;
    drainingRef.current = true;

    const context = ensureAudioContext();
    if (scheduledSourcesRef.current.size === 0) {
      nextPlaybackTimeRef.current = context.currentTime;
    }
    setSpeaking(true);

    const prefetch = () => {
      for (const item of speechQueueRef.current.slice(0, TTS_PREFETCH)) {
        if (!item.response) {
          item.response = fetchSpeech(item.text, abortController.signal);
          // The drain loop awaits this later; keep an early failure from
          // surfacing as an unhandled rejection in the meantime.
          item.response.catch(() => undefined);
        }
      }
    };

    void (async () => {
      try {
        while (speechQueueRef.current.length > 0) {
          if (playbackGenerationRef.current !== generation) {
            return;
          }

          prefetch();
          const item = speechQueueRef.current.shift();
          if (!item) break;
          const response = await (item.response ??
            fetchSpeech(item.text, abortController.signal));
          if (playbackGenerationRef.current !== generation) {
            return;
          }
          prefetch();
          if (!(await playResponse(context, response, generation))) {
            return;
          }
        }
      } catch {
        // Aborted playback or a failed synthesis: fall back to silence.
      } finally {
        if (playbackGenerationRef.current === generation) {
          drainingRef.current = false;
          playbackAbortRef.current = null;
          if (scheduledSourcesRef.current.size === 0) {
            setSpeaking(false);
          }
        }
      }
    })();
  }, [ensureAudioContext, fetchSpeech, playResponse, setSpeaking]);

  const speak = useCallback(
    (markdown: string) => {
      if (!activeRef.current) {
        return;
      }

      const chunks = chunkSpeakableText(
        toSpeakableText(markdown),
        TTS_CHUNK_CHARS,
      );

      if (chunks.length === 0) {
        return;
      }

      const queue = speechQueueRef.current;
      for (const chunk of chunks) {
        // Text arriving while earlier sentences are still waiting for their
        // request merges into the last unsent item: fewer round trips when
        // the agent is ahead of playback, no extra delay when it is not.
        const last = queue.at(-1);
        if (
          last &&
          !last.response &&
          last.text.length + chunk.length + 1 <= TTS_CHUNK_CHARS
        ) {
          last.text = `${last.text} ${chunk}`;
        } else {
          queue.push({ text: chunk });
        }
      }

      drainSpeechQueue();
    },
    [drainSpeechQueue],
  );

  // `stop` is stable (its dependency chain bottoms out in setState), so this
  // runs only on unmount.
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    active,
    status,
    interimTranscript,
    error,
    start,
    stop,
    speak,
    stopSpeaking,
    interruptions,
  };
}
