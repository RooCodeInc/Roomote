/**
 * Short synthesized earcons that mark the edges of a voice conversation, so
 * the user hears when the microphone opens and when it closes without
 * looking at the composer. Web Audio keeps this asset-free and instant.
 */

type VoiceCue = 'start' | 'stop';

const CUE_GAIN = 0.12;
const NOTE_SECONDS = 0.09;
const NOTE_GAP_SECONDS = 0.03;

/** Two quick notes: rising to open the conversation, falling to close it. */
const CUE_NOTES_HZ: Record<VoiceCue, [number, number]> = {
  start: [660, 880],
  stop: [880, 660],
};

let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (
    typeof window === 'undefined' ||
    typeof window.AudioContext !== 'function'
  ) {
    return null;
  }
  sharedContext ??= new window.AudioContext();
  return sharedContext;
}

export function playVoiceCue(cue: VoiceCue): void {
  const context = getAudioContext();
  if (!context) return;

  if (context.state === 'suspended') {
    // Resume after a user gesture; if the browser refuses, the cue is skipped.
    void context.resume().catch(() => undefined);
  }

  const startAt = context.currentTime;
  CUE_NOTES_HZ[cue].forEach((frequency, index) => {
    const noteStart = startAt + index * (NOTE_SECONDS + NOTE_GAP_SECONDS);
    const noteEnd = noteStart + NOTE_SECONDS;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, noteStart);
    gain.gain.setValueAtTime(0, noteStart);
    gain.gain.linearRampToValueAtTime(CUE_GAIN, noteStart + 0.01);
    gain.gain.linearRampToValueAtTime(0, noteEnd);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteEnd);
  });
}
