'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useTRPCClient } from '@/trpc/client';
import { chunkSpeakableText, toSpeakableText } from '@/lib/voice-speech';

const DELEGATION_TRANSCRIPT_SETTLE_MS = 250;
const SESSION_START_TIMEOUT_MS = 15_000;

export type LiveVoiceStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'error';

interface UseLiveVoiceOptions {
  /** Called when GPT-Live delegates a spoken request to the Fast session. */
  onUtterance: (text: string) => void;
  disabled?: boolean;
}

interface UseLiveVoiceReturn {
  active: boolean;
  status: LiveVoiceStatus;
  interimTranscript: string;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  /** Return verified Fast output to GPT-Live for natural spoken delivery. */
  speak: (markdown: string) => void;
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
  disabled = false,
}: UseLiveVoiceOptions): UseLiveVoiceReturn {
  const trpcClient = useTRPCClient();
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<LiveVoiceStatus>('idle');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

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
  const currentDelegationIdRef = useRef<string | null>(null);
  const delegationTimerRef = useRef<number | null>(null);
  const speakingTimerRef = useRef<number | null>(null);

  const flushDelegation = useCallback(() => {
    delegationTimerRef.current = null;
    const delegationId = pendingDelegationsRef.current[0];
    const utterance = inputTranscriptRef.current.trim();

    // GPT-Live may delegate before the last transcript delta arrives. Retain
    // the delegation and let the next delta schedule another flush.
    if (!delegationId || !utterance) return;

    pendingDelegationsRef.current.shift();
    currentDelegationIdRef.current = delegationId;
    inputTranscriptRef.current = '';
    setInterimTranscript('');
    onUtteranceRef.current(utterance);
  }, []);

  const scheduleDelegationFlush = useCallback(() => {
    if (delegationTimerRef.current !== null) {
      window.clearTimeout(delegationTimerRef.current);
    }
    delegationTimerRef.current = window.setTimeout(
      flushDelegation,
      DELEGATION_TRANSCRIPT_SETTLE_MS,
    );
  }, [flushDelegation]);

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
            inputTranscriptRef.current += event.delta;
            setInterimTranscript(inputTranscriptRef.current);
            setStatus('listening');
            if (pendingDelegationsRef.current.length > 0) {
              scheduleDelegationFlush();
            }
          }
          break;
        case 'session.output_transcript.delta':
          setStatus('speaking');
          if (speakingTimerRef.current !== null) {
            window.clearTimeout(speakingTimerRef.current);
          }
          speakingTimerRef.current = window.setTimeout(() => {
            if (activeRef.current) setStatus('listening');
          }, 800);
          break;
        case 'session.delegation.created':
          if (event.delegation?.target === 'client' && event.delegation.id) {
            pendingDelegationsRef.current.push(event.delegation.id);
            scheduleDelegationFlush();
          }
          break;
        case 'error':
          setError(event.error?.message ?? 'Voice conversation error');
          break;
        default:
          break;
      }
    },
    [scheduleDelegationFlush],
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

  const stop = useCallback(() => {
    startGenerationRef.current += 1;
    connectingRef.current = false;
    activeRef.current = false;

    if (delegationTimerRef.current !== null) {
      window.clearTimeout(delegationTimerRef.current);
      delegationTimerRef.current = null;
    }
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

    mic?.getTracks().forEach((track) => track.stop());
    audio?.pause();
    if (channel?.readyState === 'open') {
      channel.send(JSON.stringify({ type: 'session.close' }));
      window.setTimeout(() => release(peer, channel, null, audio), 1_500);
    } else {
      release(peer, channel, null, audio);
    }

    inputTranscriptRef.current = '';
    pendingDelegationsRef.current = [];
    currentDelegationIdRef.current = null;
    setActive(false);
    setStatus('idle');
    setInterimTranscript('');
  }, [release]);

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

      peer = new RTCPeerConnection();
      audio = new Audio();
      audio.autoplay = true;
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
            stop();
          }
        } catch {
          // Malformed messages are ignored by the main event handler too.
        }
      });
      channel.addEventListener('close', () => {
        if (startGenerationRef.current === generation) stop();
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
    } catch (caught) {
      release(peer, channel, mic, audio);
      if (isStale()) return;
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

  const speak = useCallback((markdown: string) => {
    const channel = dataChannelRef.current;
    if (!activeRef.current || channel?.readyState !== 'open') return;

    const chunks = chunkSpeakableText(toSpeakableText(markdown));
    for (const content of chunks) {
      channel.send(
        JSON.stringify({
          type: 'session.commentary.append',
          event_id: crypto.randomUUID(),
          delegation_id: currentDelegationIdRef.current,
          content,
        }),
      );
    }
  }, []);

  useEffect(() => stop, [stop]);

  return {
    active,
    status,
    interimTranscript,
    error,
    start,
    stop,
    speak,
  };
}
