import { INTEGRATION_SAVED_TAG } from '@roomote/types';

/**
 * The human turn Roomote sends into a Fast Session after its owner saves an
 * API key through the Session form. The technical instruction rides in an
 * `<integration_saved>` block that the Session transcript hides; the text
 * after it is what the human sees. The text is fixed: it never carries the
 * label, the reference, or anything else from the saved credential.
 */
export function buildIntegrationSavedContinuation(
  integrationKeyToolsEnabled: boolean,
): string {
  const framing = integrationKeyToolsEnabled
    ? "The human just saved an API key privately through this Session's integration form; it is now an integration for every Session they own. This block is hidden from them. Call list_integration_keys for the ready reference, then continue the work the human originally asked for, using only the approved origin and methods: if their request named what to do with the service, do it now without asking again, calling request_with_integration_key yourself for one or a few direct calls (a coding task only for scripts or many calls); on Slack or Teams, post the usual brief acknowledgement with send_chat_reply first, since actions there need one. If a call could cost them money, run the smallest bounded version and say so. Report two things separately: that the key was saved, and whether the first real call worked. Coding tasks attached to this Session receive the same integration automatically. Ask for the request path only if the request never said what to do. Never ask the human to paste credentials into chat."
    : "The human just saved an API key privately through this Session's integration form. This block is hidden from them. Integration keys are turned off for this user, so the key cannot be used from this Session yet: say that the integration was saved but cannot currently be used until they turn on Integration keys under Settings → Experimental. Do not attempt a credential-backed request and never ask them to paste credentials into chat.";
  const visible = integrationKeyToolsEnabled
    ? 'I added the integration, go ahead.'
    : 'I added the integration.';
  return `<${INTEGRATION_SAVED_TAG}>\n${framing}\n</${INTEGRATION_SAVED_TAG}>\n${visible}`;
}
