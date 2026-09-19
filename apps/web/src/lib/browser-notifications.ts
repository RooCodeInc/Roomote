export type BrowserNotificationCapability =
  | NotificationPermission
  | 'unsupported';

const PROMPT_STATE_KEY = 'roomote-browser-notification-prompt-v1';
const CLAIM_PREFIX = 'roomote-browser-notification-claim-v1:';
const CLAIM_TTL_MS = 15_000;

export function getBrowserNotificationCapability(): BrowserNotificationCapability {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  // Page-created notifications are not supported by the major mobile browsers.
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export function getBrowserNotificationPromptState():
  | 'shown'
  | 'dismissed'
  | null {
  const value = localStorage.getItem(PROMPT_STATE_KEY);
  return value === 'shown' || value === 'dismissed' ? value : null;
}

export function setBrowserNotificationPromptState(
  state: 'shown' | 'dismissed',
) {
  localStorage.setItem(PROMPT_STATE_KEY, state);
}

export function claimBrowserNotification(eventKey: string): boolean {
  const key = `${CLAIM_PREFIX}${eventKey}`;
  const now = Date.now();
  const existing = Number(localStorage.getItem(key));
  if (Number.isFinite(existing) && now - existing < CLAIM_TTL_MS) return false;
  localStorage.setItem(key, String(now));
  return localStorage.getItem(key) === String(now);
}
