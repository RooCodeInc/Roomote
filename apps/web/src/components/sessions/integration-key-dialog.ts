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
