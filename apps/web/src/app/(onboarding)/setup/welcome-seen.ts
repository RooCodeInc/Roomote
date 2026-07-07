'use client';

const WELCOME_SEEN_STORAGE_KEY = 'roomote-setup-welcome-seen';

/**
 * The signed-out bootstrap flow and the signed-in setup wizard are separate
 * step machines that both start with the welcome screen. Account creation
 * redirects back to /setup and discards the bootstrap flow's component
 * state, so this sessionStorage marker is what carries "the user already
 * saw the welcome screen" across that signup boundary.
 */
export function markSetupWelcomeSeen(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.setItem(WELCOME_SEEN_STORAGE_KEY, 'true');
  } catch {
    // Ignore sessionStorage failures.
  }
}

export function hasSeenSetupWelcome(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.sessionStorage.getItem(WELCOME_SEEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}
