export const WHATS_NEW_SEEN_VERSION_KEY = 'RoomoteWhatsNewSeenVersion';

export function readWhatsNewSeenVersion(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const value = window.localStorage.getItem(WHATS_NEW_SEEN_VERSION_KEY);
    return value?.trim() || null;
  } catch {
    return null;
  }
}

export function writeWhatsNewSeenVersion(version: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(WHATS_NEW_SEEN_VERSION_KEY, version);
  } catch {
    // Ignore quota / private-mode failures.
  }
}
