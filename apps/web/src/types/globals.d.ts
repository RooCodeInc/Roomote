import 'react';

type AppSpeechRecognitionEvent = Event & {
  results: SpeechRecognitionResultList;
  resultIndex: number;
};

type AppSpeechRecognitionErrorEvent = Event & {
  error: string;
  message: string;
};

type AppSpeechRecognitionInstance = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: AppSpeechRecognitionEvent) => void) | null;
  onerror: ((event: AppSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

type AppSpeechRecognitionConstructor = new () => AppSpeechRecognitionInstance;

declare global {
  interface Window {
    SpeechRecognition?: AppSpeechRecognitionConstructor;
    webkitSpeechRecognition?: AppSpeechRecognitionConstructor;
  }
}

declare module 'react' {
  interface CSSProperties {
    [key: `--${string}`]: string | number;
  }
}
