'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Web Speech API type declarations for environments that lack them.
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

const SPEECH_RECOGNITION_ERRORS = [
  'aborted',
  'audio-capture',
  'bad-grammar',
  'language-not-supported',
  'network',
  'no-speech',
  'not-allowed',
  'phrases-not-supported',
  'service-not-allowed',
] as const;

type KnownSpeechRecognitionError = (typeof SPEECH_RECOGNITION_ERRORS)[number];

const KNOWN_SPEECH_RECOGNITION_ERROR_SET: ReadonlySet<string> = new Set(
  SPEECH_RECOGNITION_ERRORS,
);

interface SpeechRecognitionErrorEvent extends Event {
  error: KnownSpeechRecognitionError | (string & {});
  message: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

type RestartablePhase = 'idle' | 'waiting_for_prompt';

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/**
 * Phases that indicate the task is ready to accept a new prompt. Used by
 * mobile auto-restart logic to begin recording again once the agent finishes.
 */
function isKnownSpeechRecognitionError(
  error: string,
): error is KnownSpeechRecognitionError {
  return KNOWN_SPEECH_RECOGNITION_ERROR_SET.has(error);
}

function isRestartablePhase(phase: string): phase is RestartablePhase {
  return phase === 'idle' || phase === 'waiting_for_prompt';
}

interface UseVoiceDictationOptions {
  /** Called with transcript text (interim or final). */
  onTranscript: (text: string, isFinal: boolean) => void;

  /** Called when a final result is ready and should be sent (mobile mode). */
  onAutoSend?: (text: string) => void;

  /**
   * Called when recording starts to capture a prefix that will be prepended to
   * every transcript passed to `onTranscript`. Useful for appending dictated
   * text after whatever is already in the input.
   */
  getPrefix?: () => string;

  /** Whether to auto-send on final result (mobile mode). */
  autoSend?: boolean;

  /** Whether to auto-restart after task returns to idle. */
  autoRestart?: boolean;

  /** Current task phase -- used for auto-restart logic. */
  taskPhase?: string;

  /** Whether the input is disabled (not connected, sending, etc.). */
  disabled?: boolean;
}

interface UseVoiceDictationReturn {
  /** Whether the Web Speech API is supported in this browser. */
  isSupported: boolean;

  /** Whether currently recording. */
  isRecording: boolean;

  /** Toggle recording on/off. */
  toggle: () => void;

  /** Force stop recording. */
  stop: () => void;
}

export function useVoiceDictation({
  onTranscript,
  onAutoSend,
  getPrefix,
  autoSend = false,
  autoRestart = false,
  taskPhase,
  disabled = false,
}: UseVoiceDictationOptions): UseVoiceDictationReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isSupported, setIsSupported] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  // Whether the user has actively engaged voice mode during this session.
  // Prevents auto-restart from firing if the user never clicked the mic.
  const voiceModeActive = useRef(false);

  // Track whether we intentionally stopped recording (to distinguish from
  // browser-triggered onend events).
  const intentionalStop = useRef(false);

  // Keep latest callbacks in refs so the recognition event handlers always
  // use the current closure without requiring recreation.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const onAutoSendRef = useRef(onAutoSend);
  onAutoSendRef.current = onAutoSend;

  const getPrefixRef = useRef(getPrefix);
  getPrefixRef.current = getPrefix;

  const autoSendRef = useRef(autoSend);
  autoSendRef.current = autoSend;

  // Prefix captured at recording start, prepended to all transcripts.
  const prefixRef = useRef('');

  // Defer the browser-capability check to a client-only effect so the
  // server and first client render both start with `false`, avoiding a
  // React hydration mismatch.
  useEffect(() => {
    setIsSupported(!!getSpeechRecognition());
  }, []);

  const stopRecording = useCallback(() => {
    intentionalStop.current = true;

    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }

    setIsRecording(false);
  }, []);

  const startRecording = useCallback(() => {
    if (disabled) {
      return;
    }

    const SpeechRecognition = getSpeechRecognition();

    if (!SpeechRecognition) {
      return;
    }

    // Stop any existing instance before starting a new one.
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }

    intentionalStop.current = false;
    const recognition = new SpeechRecognition();
    recognition.interimResults = true;
    recognition.continuous = autoSendRef.current;

    recognition.onstart = () => {
      prefixRef.current = getPrefixRef.current?.() ?? '';
      setIsRecording(true);
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];

        if (!result?.[0]) {
          continue;
        }

        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      const prefix = prefixRef.current;

      if (finalTranscript) {
        const trimmed = finalTranscript.trim();
        onTranscriptRef.current(prefix + trimmed, true);

        if (autoSendRef.current && onAutoSendRef.current && trimmed) {
          onAutoSendRef.current(trimmed);
        }
      } else if (interimTranscript) {
        onTranscriptRef.current(prefix + interimTranscript, false);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "aborted" fires when we intentionally call .abort() -- not an error.
      if (event.error === 'aborted') {
        return;
      }

      if (isKnownSpeechRecognitionError(event.error)) {
        console.warn('[voice-dictation] SpeechRecognition error:', event.error);
      } else {
        console.warn(
          '[voice-dictation] Unknown SpeechRecognition error:',
          event.error,
        );
      }

      setIsRecording(false);
      recognitionRef.current = null;
    };

    recognition.onend = () => {
      // If we didn't intentionally stop and continuous mode is active,
      // the browser may have ended recognition on its own (e.g. silence
      // timeout). In continuous/mobile mode we want to keep going.
      if (
        !intentionalStop.current &&
        autoSendRef.current &&
        voiceModeActive.current
      ) {
        // Restart after a brief delay to avoid rapid restart loops.
        setTimeout(() => {
          if (voiceModeActive.current && !intentionalStop.current) {
            try {
              recognition.start();
            } catch {
              // Recognition may fail if component unmounted or permissions revoked.
              setIsRecording(false);
              recognitionRef.current = null;
            }
          }
        }, 100);

        return;
      }

      setIsRecording(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch {
      // If start() throws (e.g. mic permission denied), clean up.
      setIsRecording(false);
      recognitionRef.current = null;
    }
  }, [disabled]);

  const toggle = useCallback(() => {
    if (isRecording) {
      voiceModeActive.current = false;
      stopRecording();
    } else {
      voiceModeActive.current = true;
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // Auto-restart logic for mobile: when the task phase returns to a
  // restartable state and voice mode was previously activated, restart.
  useEffect(() => {
    if (!autoRestart || !voiceModeActive.current || !taskPhase || disabled) {
      return;
    }

    const shouldRestart = isRestartablePhase(taskPhase) && !isRecording;

    if (shouldRestart) {
      const timer = setTimeout(() => {
        if (voiceModeActive.current && !isRecording) {
          startRecording();
        }
      }, 300);

      return () => clearTimeout(timer);
    }
  }, [taskPhase, autoRestart, isRecording, startRecording, disabled]);

  // Clean up on unmount: stop any active recording.
  useEffect(() => {
    return () => {
      voiceModeActive.current = false;

      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
    };
  }, []);

  // Stop recording when the input becomes disabled.
  useEffect(() => {
    if (disabled && isRecording) {
      stopRecording();
    }
  }, [disabled, isRecording, stopRecording]);

  return { isSupported, isRecording, toggle, stop: stopRecording };
}
