/**
 * The key dialog on a Session page opens on this URL fragment. Agent links,
 * the pending-key card, and the automatic open after a request all go through
 * the same fragment, so there is exactly one way the dialog appears.
 */
export const INTEGRATION_KEY_DIALOG_HASH = '#integrations';

export function openIntegrationKeyDialog() {
  if (window.location.hash === INTEGRATION_KEY_DIALOG_HASH) return;
  window.location.hash = INTEGRATION_KEY_DIALOG_HASH;
}

/** Fired on `window` after the owner saves a key, so pending-key views refetch. */
export const INTEGRATION_KEYS_CHANGED_EVENT =
  'roomote:integration-keys-changed';

export function notifyIntegrationKeysChanged() {
  window.dispatchEvent(new Event(INTEGRATION_KEYS_CHANGED_EVENT));
}
