/**
 * Query flag that opens a Session straight into a voice conversation. It
 * lives in a plain module because the server page reads it: importing a
 * value from a `'use client'` module into a server component yields a client
 * reference stub, not the string.
 */
export const VOICE_AUTOSTART_QUERY_PARAM = 'voice';
const VOICE_AUTOSTART_QUERY_VALUE = '1';

/** Path of a Session that should start voice as soon as it opens. */
export function sessionPathWithVoiceAutostart(sessionId: string): string {
  return `/sessions/${sessionId}?${VOICE_AUTOSTART_QUERY_PARAM}=${VOICE_AUTOSTART_QUERY_VALUE}`;
}

/** Whether a page's resolved search params carry the voice autostart flag. */
export function hasVoiceAutostartFlag(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): boolean {
  return (
    searchParams?.[VOICE_AUTOSTART_QUERY_PARAM] === VOICE_AUTOSTART_QUERY_VALUE
  );
}
