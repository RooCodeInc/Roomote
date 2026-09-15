/**
 * The human turn Roomote sends into a Fast Session after its owner saves an
 * API key through the Session form. The technical instruction rides in the
 * same Roomote-injected `<environment-instructions>` block that task
 * transcripts already hide, and only the `<request>` text is shown in the
 * Session transcript. The text is fixed: it never carries the label, the
 * reference, or anything else from the saved credential.
 */
export function buildIntegrationSavedContinuation(
  integrationKeyToolsEnabled: boolean,
): string {
  const framing = integrationKeyToolsEnabled
    ? "The human just saved an API key privately through this Session's integration form; it is now an integration for every Session they own. This block is hidden from them. Call list_integration_keys for the ready reference, then continue the requested work using only the approved origin and methods. Coding tasks attached to this Session receive the same integration automatically. Ask for the request path only if it is still unknown. Never ask the human to paste credentials into chat."
    : "The human just saved an API key privately through this Session's integration form. This block is hidden from them. Integration keys are turned off for this user, so the key cannot be used from this Session yet: say that the integration was saved but cannot currently be used until they turn on Integration keys under Settings → Experimental. Do not attempt a credential-backed request and never ask them to paste credentials into chat.";
  const request = integrationKeyToolsEnabled
    ? 'I added the integration, go ahead.'
    : 'I added the integration.';
  return `<environment-instructions>\n${framing}\n</environment-instructions>\n<request>${request}</request>`;
}
