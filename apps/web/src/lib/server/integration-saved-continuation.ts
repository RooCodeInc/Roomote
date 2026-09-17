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
    ? "The human just saved an API key privately through this Session's integration form; it is now an integration for every Session they own. This block is hidden from them. Unless this Session's home surface is the web, post the usual brief acknowledgement with send_chat_reply before anything else, since every credential tool on other surfaces needs one. Then call list_integration_keys for the ready reference and continue the work the human originally asked for, using only the approved origin and methods: if their request named what to do with the service, do it now without asking again, calling request_with_integration_key yourself for one or a few direct calls (a coding task only for scripts or many calls). If a call could cost them money, run the smallest bounded version and say so. Report two things separately: that the key was saved, and whether the first real call worked. Coding tasks attached to this Session receive the same integration automatically. Ask for the request path only if the request never said what to do. Never ask the human to paste credentials into chat."
    : "The human just saved an API key privately through this Session's integration form. This block is hidden from them. Integration keys are turned off for this user, so the key cannot be used from this Session yet: say that the integration was saved but cannot currently be used until they turn on Integration keys under Settings → Experimental. Do not attempt a credential-backed request and never ask them to paste credentials into chat.";
  const visible = integrationKeyToolsEnabled
    ? 'I added the integration, go ahead.'
    : 'I added the integration.';
  return `<${INTEGRATION_SAVED_TAG}>\n${framing}\n</${INTEGRATION_SAVED_TAG}>\n${visible}`;
}

export function buildRemoteMcpConnectedContinuation(name: string): string {
  const framing = `The requesting deployment administrator just authorized the custom remote MCP integration '${name}' through the secure OAuth flow. This block is hidden from them. Unless this Session's home surface is the web, post the usual brief acknowledgement with send_chat_reply before anything else. Confirm that it is connected and report the tool count. When tools are available, name up to three that are most relevant to the original request; when the count is zero, report only the count and do not invent tool names. Then continue the original request automatically. Inspect tools silently as needed, but do not dump the full tool list or mention internal recovery, integration IDs, catalog checks, or probing. Never ask the human to send a follow-up, quote this block, expose OAuth details, or ask for credentials in chat.`;
  return `<${INTEGRATION_SAVED_TAG}>\n${framing}\n</${INTEGRATION_SAVED_TAG}>\nI authorized the integration, go ahead.`;
}
