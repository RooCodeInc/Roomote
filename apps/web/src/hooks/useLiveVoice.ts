'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTRPCClient } from '@/trpc/client';
import { playVoiceCue } from '@/lib/voice-cues';
import { chunkSpeakableText, toSpeakableText } from '@/lib/voice-speech';

const DELEGATION_TRANSCRIPT_SETTLE_MS = 250;
/**
 * Speech GPT-Live answers itself never produces a delegation. After this much
 * silence with no delegation the utterance is recorded as a heard turn so the
 * Session transcript still has it.
 */
const UTTERANCE_SILENCE_FLUSH_MS = 1_500;
/** A delegation this soon after a silence flush belongs to that utterance. */
const STALE_DELEGATION_WINDOW_MS = 3_000;
/** GPT-Live has finished a spoken turn once its transcript stops growing. */
const SPOKEN_TURN_SETTLE_MS = 1_200;
const SESSION_START_TIMEOUT_MS = 15_000;

type LiveVoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'error';

interface UseLiveVoiceOptions {
  /**
   * Called with each finished utterance for the Fast session. The delegation
   * id is null when the utterance was flushed on silence rather than through
   * a GPT-Live delegation; its reply is then spoken as session-wide commentary.
   */
  onUtterance: (text: string, delegationId: string | null) => void;
  /**
   * Called with the transcript of each thing GPT-Live said, once it finishes
   * speaking a turn. This is the spoken record the Session persists.
   */
  onSpokenTurn?: (text: string) => void;
  /**
   * Called with the raw transcript of what the person said each time GPT-Live
   * handles it without delegating (small talk), so the Session still records
   * it. Delegated utterances reach the Session through `onUtterance`.
   */
  onHeardTurn?: (text: string) => void;
  /** Called with GPT-Live's words so far while it is speaking a turn. */
  onSpokenTurnDelta?: (text: string) => void;
  /** Called with the person's words so far while they are speaking. */
  onHeardTurnDelta?: (text: string) => void;
  disabled?: boolean;
}

interface UseLiveVoiceReturn {
  active: boolean;
  status: LiveVoiceStatus;
  start: () => Promise<void>;
  /**
   * End the conversation. `silent` skips the stop cue for handoffs where
   * voice continues elsewhere (a new Session opening in voice mode).
   */
  stop: (options?: { silent?: boolean }) => void;
  /** Return verified Fast output to GPT-Live for natural spoken delivery. */
  speak: (markdown: string, delegationId: string | null) => void;
  /** Microphone muted: GPT-Live hears nothing until unmuted. */
  micMuted: boolean;
  setMicMuted: (muted: boolean) => void;
  /** Output muted: GPT-Live keeps talking, the speaker stays quiet. */
  outputMuted: boolean;
  setOutputMuted: (muted: boolean) => void;
  /** Milliseconds since the conversation connected, 0 when idle. */
  startedAt: number | null;
  /**
   * Utterances that have ended but not yet reached `onUtterance` (transcript
   * cleanup in flight). Callers use it to keep spoken replies ordered after
   * the request they answer.
   */
  deliveringUtterances: number;
}

type LiveServerEvent = {
  type?: string;
  delta?: string;
  offset_ms?: number;
  delegation?: { id?: string; target?: string };
  error?: { message?: string };
};

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return;

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      peer.removeEventListener('icegatheringstatechange', handleState);
      reject(new Error('Timed out while preparing the voice connection'));
    }, 10_000);
    const handleState = () => {
      if (peer.iceGatheringState !== 'complete') return;
      window.clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', handleState);
      resolve();
    };

    peer.addEventListener('icegatheringstatechange', handleState);
    handleState();
  });
}

/**
 * One GPT-Live WebRTC conversation backed by the existing Fast session. Live
 * owns microphone turn-taking, native audio, and interruption; client
 * delegation sends substantive work through the caller's normal Fast path.
 */
export function useLiveVoice({
  onUtterance,
  onSpokenTurn,
  onHeardTurn,
  onSpokenTurnDelta,
  onHeardTurnDelta,
  disabled = false,
}: UseLiveVoiceOptions): UseLiveVoiceReturn {
  const trpcClient = useTRPCClient();
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<LiveVoiceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [micMuted, setMicMutedState] = useState(false);
  const [outputMuted, setOutputMutedState] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [deliveringUtterances, setDeliveringUtterances] = useState(0);
  const onSpokenTurnRef = useRef(onSpokenTurn);
  onSpokenTurnRef.current = onSpokenTurn;
  const onHeardTurnRef = useRef(onHeardTurn);
  onHeardTurnRef.current = onHeardTurn;
  const onSpokenTurnDeltaRef = useRef(onSpokenTurnDelta);
  onSpokenTurnDeltaRef.current = onSpokenTurnDelta;
  const onHeardTurnDeltaRef = useRef(onHeardTurnDelta);
  onHeardTurnDeltaRef.current = onHeardTurnDelta;
  // GPT-Live's own words for the turn it is speaking now, flushed to the
  // Session once it goes quiet or the person speaks again.
  const outputTranscriptRef = useRef('');
  const outputSettleTimerRef = useRef<number | null>(null);

  // The composer has no status strip, so failures surface as a toast.
  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const outputAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeRef = useRef(false);
  const connectingRef = useRef(false);
  const startGenerationRef = useRef(0);
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  const inputTranscriptRef = useRef('');
  const pendingDelegationsRef = useRef<string[]>([]);
  const delegationTimerRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const lastSilenceFlushAtRef = useRef(0);
  const speakingTimerRef = useRef<number | null>(null);
  const deliveryChainRef = useRef<Promise<void>>(Promise.resolve());

  // Raw speech-to-text is full of disfluencies and misheard terms, so the
  // utterance is cleaned before it enters the transcript. Delivery is
  // chained so back-to-back requests keep their spoken order, and a
  // conversation ended mid-cleanup drops its in-flight request like any
  // other pending delegation.
  const deliverUtterance = useCallback(
    (utterance: string, delegationId: string | null) => {
      const generation = startGenerationRef.current;
      setDeliveringUtterances((count) => count + 1);
      deliveryChainRef.current = deliveryChainRef.current
        .then(async () => {
          let text = utterance;
          try {
            const cleaned = await trpcClient.voice.cleanTranscript.mutate({
              text: utterance,
            });
            if (cleaned.text.trim()) text = cleaned.text.trim();
          } catch {
            // The raw transcript still carries the request.
          }
          if (startGenerationRef.current !== generation) return;
          onUtteranceRef.current(text, delegationId);
        })
        .finally(() => {
          setDeliveringUtterances((count) => Math.max(0, count - 1));
        });
    },
    [trpcClient],
  );

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const flushSpokenTurn = useCallback(() => {
    if (outputSettleTimerRef.current !== null) {
      window.clearTimeout(outputSettleTimerRef.current);
      outputSettleTimerRef.current = null;
    }
    const spoken = outputTranscriptRef.current.trim();
    outputTranscriptRef.current = '';
    if (spoken) onSpokenTurnRef.current?.(spoken);
  }, []);

  const flushDelegation = useCallback(() => {
    delegationTimerRef.current = null;
    const delegationId = pendingDelegationsRef.current[0];
    const utterance = inputTranscriptRef.current.trim();

    // GPT-Live may delegate before the last transcript delta arrives. Retain
    // the delegation and let the next delta schedule another flush.
    if (!delegationId || !utterance) return;

    pendingDelegationsRef.current.shift();
    inputTranscriptRef.current = '';
    clearSilenceTimer();
    deliverUtterance(utterance, delegationId);
  }, [clearSilenceTimer, deliverUtterance]);

  const scheduleDelegationFlush = useCallback(() => {
    if (delegationTimerRef.current !== null) {
      window.clearTimeout(delegationTimerRef.current);
    }
    delegationTimerRef.current = window.setTimeout(
      flushDelegation,
      DELEGATION_TRANSCRIPT_SETTLE_MS,
    );
  }, [flushDelegation]);

  // Speech GPT-Live handles itself (small talk) never produces a delegation.
  // Once the person has been quiet for a moment, record what they said so the
  // Session transcript stays the complete record of the call.
  const scheduleSilenceFlush = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = window.setTimeout(() => {
      silenceTimerRef.current = null;
      const utterance = inputTranscriptRef.current.trim();
      if (!utterance || pendingDelegationsRef.current.length > 0) return;
      inputTranscriptRef.current = '';
      lastSilenceFlushAtRef.current = Date.now();
      onHeardTurnRef.current?.(utterance);
    }, UTTERANCE_SILENCE_FLUSH_MS);
  }, [clearSilenceTimer]);

  const handleServerEvent = useCallback(
    (raw: string) => {
      let event: LiveServerEvent;
      try {
        event = JSON.parse(raw) as LiveServerEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case 'session.input_transcript.delta':
          if (event.delta) {
            // The person is talking again: whatever GPT-Live said is done.
            if (outputTranscriptRef.current) flushSpokenTurn();
            inputTranscriptRef.current += event.delta;
            onHeardTurnDeltaRef.current?.(inputTranscriptRef.current);
            setStatus('listening');
            if (pendingDelegationsRef.current.length > 0) {
              scheduleDelegationFlush();
            } else {
              scheduleSilenceFlush();
            }
          }
          break;
        case 'session.output_transcript.delta':
          setStatus('speaking');
          if (event.delta) {
            outputTranscriptRef.current += event.delta;
            onSpokenTurnDeltaRef.current?.(outputTranscriptRef.current);
          }
          if (speakingTimerRef.current !== null) {
            window.clearTimeout(speakingTimerRef.current);
          }
          speakingTimerRef.current = window.setTimeout(() => {
            if (activeRef.current) setStatus('listening');
          }, 800);
          if (outputSettleTimerRef.current !== null) {
            window.clearTimeout(outputSettleTimerRef.current);
          }
          outputSettleTimerRef.current = window.setTimeout(
            flushSpokenTurn,
            SPOKEN_TURN_SETTLE_MS,
          );
          break;
        case 'session.delegation.created':
          if (event.delegation?.target === 'client' && event.delegation.id) {
            // A delegation arriving just after the silence flush already sent
            // that utterance; attaching it to the next one would skew replies.
            if (
              !inputTranscriptRef.current.trim() &&
              Date.now() - lastSilenceFlushAtRef.current <
                STALE_DELEGATION_WINDOW_MS
            ) {
              break;
            }
            pendingDelegationsRef.current.push(event.delegation.id);
            scheduleDelegationFlush();
          }
          break;
        case 'error':
          console.error('[voice] GPT-Live reported an error', event);
          setError(event.error?.message ?? 'Voice conversation error');
          break;
        default:
          break;
      }
    },
    [flushSpokenTurn, scheduleDelegationFlush, scheduleSilenceFlush],
  );

  const release = useCallback(
    (
      peer: RTCPeerConnection | null,
      channel: RTCDataChannel | null,
      mic: MediaStream | null,
      audio: HTMLAudioElement | null,
    ) => {
      mic?.getTracks().forEach((track) => track.stop());
      channel?.close();
      peer?.close();
      if (audio) {
        audio.pause();
        audio.srcObject = null;
      }
    },
    [],
  );

  const stop = useCallback(
    (options?: { silent?: boolean }) => {
      // Only a conversation that was actually open gets a closing cue; an
      // aborted handshake never announced itself.
      const wasActive = activeRef.current;
      startGenerationRef.current += 1;
      connectingRef.current = false;
      activeRef.current = false;

      if (delegationTimerRef.current !== null) {
        window.clearTimeout(delegationTimerRef.current);
        delegationTimerRef.current = null;
      }
      clearSilenceTimer();
      flushSpokenTurn();
      if (speakingTimerRef.current !== null) {
        window.clearTimeout(speakingTimerRef.current);
        speakingTimerRef.current = null;
      }

      const peer = peerRef.current;
      const channel = dataChannelRef.current;
      const mic = micStreamRef.current;
      const audio = outputAudioRef.current;
      peerRef.current = null;
      dataChannelRef.current = null;
      micStreamRef.current = null;
      outputAudioRef.current = null;

      if (channel?.readyState === 'open') {
        channel.send(JSON.stringify({ type: 'session.close' }));
      }
      release(peer, channel, mic, audio);

      inputTranscriptRef.current = '';
      pendingDelegationsRef.current = [];
      setActive(false);
      setStatus('idle');
      setStartedAt(null);
      setMicMutedState(false);
      setOutputMutedState(false);
      if (wasActive && !options?.silent) playVoiceCue('stop');
    },
    [clearSilenceTimer, flushSpokenTurn, release],
  );

  const start = useCallback(async () => {
    if (activeRef.current || connectingRef.current || disabled) return;

    const generation = ++startGenerationRef.current;
    const isStale = () => startGenerationRef.current !== generation;
    connectingRef.current = true;
    setError(null);
    setStatus('connecting');

    let mic: MediaStream | null = null;
    let peer: RTCPeerConnection | null = null;
    let channel: RTCDataChannel | null = null;
    let audio: HTMLAudioElement | null = null;

    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (isStale()) {
        release(peer, channel, mic, audio);
        return;
      }
      micStreamRef.current = mic;

      peer = new RTCPeerConnection();
      audio = new Audio();
      audio.autoplay = true;
      peerRef.current = peer;
      outputAudioRef.current = audio;
      peer.addEventListener('track', (event) => {
        if (!audio) return;
        audio.srcObject = new MediaStream([event.track]);
        void audio.play().catch(() => {
          setError('Select play in your browser to hear the conversation');
        });
      });

      const [audioTrack] = mic.getAudioTracks();
      if (!audioTrack) throw new Error('No microphone available');
      peer.addTrack(audioTrack, mic);

      channel = peer.createDataChannel('oai-events');
      dataChannelRef.current = channel;
      channel.addEventListener('message', (event) =>
        handleServerEvent(String(event.data)),
      );
      channel.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as LiveServerEvent;
          if (
            message.type === 'session.closed' &&
            startGenerationRef.current === generation
          ) {
            console.info('[voice] GPT-Live closed the session', message);
            stop();
          }
        } catch {
          // Malformed messages are ignored by the main event handler too.
        }
      });
      channel.addEventListener('close', () => {
        if (startGenerationRef.current === generation) {
          console.info('[voice] Data channel closed by the peer');
          stop();
        }
      });
      peer.addEventListener('connectionstatechange', () => {
        console.info(`[voice] Peer connection ${peer?.connectionState}`);
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      if (isStale()) {
        release(peer, channel, mic, audio);
        return;
      }

      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('Missing voice connection offer');
      const result = await trpcClient.voice.createLiveSession.mutate({ sdp });
      if (isStale()) {
        release(peer, channel, mic, audio);
        return;
      }

      const started = new Promise<void>((resolveStarted, rejectStarted) => {
        const handleStarted = (event: MessageEvent) => {
          try {
            const message = JSON.parse(String(event.data)) as LiveServerEvent;
            if (message.type !== 'session.started') return;
            window.clearTimeout(timeout);
            channel?.removeEventListener('message', handleStarted);
            resolveStarted();
          } catch {
            // Other data-channel messages are handled by handleServerEvent.
          }
        };
        const timeout = window.setTimeout(() => {
          channel?.removeEventListener('message', handleStarted);
          rejectStarted(new Error('Voice session did not start'));
        }, SESSION_START_TIMEOUT_MS);
        channel?.addEventListener('message', handleStarted);
      });
      await Promise.all([
        peer.setRemoteDescription({ type: 'answer', sdp: result.sdp }),
        started,
      ]);
      if (isStale()) {
        release(peer, channel, mic, audio);
        return;
      }

      peerRef.current = peer;
      dataChannelRef.current = channel;
      micStreamRef.current = mic;
      outputAudioRef.current = audio;
      connectingRef.current = false;
      activeRef.current = true;
      setActive(true);
      setStatus('listening');
      setStartedAt(Date.now());
      playVoiceCue('start');
    } catch (caught) {
      console.error('[voice] Could not start the voice conversation', caught);
      release(peer, channel, mic, audio);
      if (isStale()) return;
      if (peerRef.current === peer) peerRef.current = null;
      if (dataChannelRef.current === channel) dataChannelRef.current = null;
      if (micStreamRef.current === mic) micStreamRef.current = null;
      if (outputAudioRef.current === audio) outputAudioRef.current = null;
      connectingRef.current = false;
      setActive(false);
      setStatus('error');
      setError(
        caught instanceof Error && caught.name === 'NotAllowedError'
          ? 'Microphone access was denied'
          : 'Could not start the voice conversation',
      );
    }
  }, [disabled, handleServerEvent, release, stop, trpcClient]);

  const speak = useCallback((markdown: string, delegationId: string | null) => {
    const channel = dataChannelRef.current;
    if (!activeRef.current || channel?.readyState !== 'open') return;

    const chunks = chunkSpeakableText(toSpeakableText(markdown));
    for (const content of chunks) {
      channel.send(
        JSON.stringify({
          type: 'session.commentary.append',
          event_id: crypto.randomUUID(),
          delegation_id: delegationId,
          content,
        }),
      );
    }
  }, []);

  const setMicMuted = useCallback((muted: boolean) => {
    setMicMutedState(muted);
    micStreamRef.current
      ?.getAudioTracks()
      .forEach((track) => (track.enabled = !muted));
  }, []);

  const setOutputMuted = useCallback((muted: boolean) => {
    setOutputMutedState(muted);
    if (outputAudioRef.current) outputAudioRef.current.muted = muted;
  }, []);

  useEffect(() => () => stop(), [stop]);

  return {
    active,
    status,
    start,
    stop,
    speak,
    micMuted,
    setMicMuted,
    outputMuted,
    setOutputMuted,
    startedAt,
    deliveringUtterances,
  };
}
