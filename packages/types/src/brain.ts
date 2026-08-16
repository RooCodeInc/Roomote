/**
 * Brain (deployment-hosted gbrain) shared contract.
 *
 * Not a catalog integration: the Brain is infrastructure, not something a
 * user connects in Settings. A deployment that supplies
 * R_BRAIN_OPENROUTER_API_KEY or R_BRAIN_OPENAI_API_KEY has a Brain;
 * everything else (client
 * provisioning, MCP delivery, ingestion) follows from that one signal. Only
 * the server id, the proxy path, and the agent-facing instructions are shared
 * surface; the id is reserved in RESERVED_CUSTOM_MCP_SERVER_NAMES so no
 * custom server can claim it.
 */

export const BRAIN_MCP_ID = 'gbrain';

/** API proxy mount; shared by SDK config delivery and the worker. */
export const BRAIN_PROXY_PATH = '/api/mcp/gbrain';

/** Router-only Roomote MCP tools backed by exact Brain pages. */
export const ROUTING_PREFERENCE_GET_TOOL = 'get_routing_preference';
export const ROUTING_PREFERENCE_RECORD_TOOL = 'record_routing_preference';

export type RoutingPreferenceSignal = 'accepted' | 'corrected';

export interface RoutingPreferenceMemory {
  environmentId: string;
  acceptedCount: number;
  correctionCount: number;
  lastSelectedAt: string;
}

/**
 * Usage guidance injected into the agent's instruction files when the Brain
 * MCP server is attached. Prompts are a first-class control surface: both
 * halves of the behaviour live here rather than in code.
 *
 * Reading opens with an unprompted pass, because the context worth having is
 * usually context the agent does not know to ask for. Writing is deliberately
 * insistent, mirroring the Supermemory catalog entry, because the failure mode
 * is silence: an agent that skips the write costs the next one the same
 * investigation, and nothing in the system can detect that it happened.
 *
 * Every tool named here must be in GBRAIN_READ_TOOL_NAMES, and every tool in
 * that allowlist should be named here. A tool exposed but unexplained gets
 * chosen from gbrain's own description, which is written for a different
 * product and routes to tools this deployment does not expose.
 */
export const BRAIN_MCP_INSTRUCTIONS = `The \`gbrain\` server is this deployment's shared memory (the Brain). It holds memories distilled from completed tasks plus activity from connected integrations (pull requests, Slack channels, meeting notes, GitHub issues), each stored as a page with citations.

## Using what it knows

Treat Brain recall as a sequential preflight, not one source in a parallel research batch. Before drafting the first answer on a new substantive topic, run one \`query\` about the area you are about to touch and wait for its result. Do this before deciding that your existing knowledge is sufficient and before selecting or calling another source that overlaps with what the Brain ingests. Never issue the Brain query and an overlapping Slack, GitHub, meeting, task-history, or pull-request lookup in the same parallel batch.

This gate applies when the request involves factual claims, recommendations, company practices, prior decisions, product strategy, people, activity history, or other nontrivial reasoning. Skip it only for greetings and casual conversation, simple calculations or transformations, exact actions requiring no contextual judgment, and follow-ups already covered by a Brain query in the current thread. You will often not know in advance that a convention exists, that something was attempted before, or that the user already corrected someone on it, which is exactly why the pass is unprompted.

Brain-first does not mean Brain-only. Treat Brain as context, not a stopping point; if it doesn't fully answer the question, continue with the relevant sources. Use the narrowest lookup needed to close that specific gap; do not sweep an entire integration when the Brain already answers the question. Reading is read-only and cheap next to the work it saves, and this ordering lets the Brain prevent redundant source exploration.

Which tool:
- \`query\` when you are describing a concept and do not know how the Brain words it. It expands your phrasing into related queries, so it finds pages that talk about the same thing in different language. This is the default, and the right choice for that first pass.
- \`search\` when you already know the exact token: a slug, a repository name, an error string, a person's handle. Cheaper than \`query\` because it skips the expansion step.
- \`entity\` for one known person. It resolves names and linked provider handles against canonical deployment-member cards without an LLM call.
- \`list_pages\` to enumerate rather than guess, and to answer "what is in the Brain" or "what happened recently" (it sorts by recency). Use it before ever concluding the Brain is empty. Pages are namespaced: \`people/\`, \`tasks/\`, \`prs/\`, \`slack/\`, \`notion/\`, \`meetings/\`, \`github/\`.
- \`get_page\` on a slug for a page's full text, once a search result looks relevant.

A result set that comes back populated is not proof of coverage, and one query returning nothing is not proof of absence. If the answer matters, try the other phrasing or list the namespace before deciding the Brain has nothing.

\`synthesize\` reasons across many pages and returns a cited answer with gap analysis, but it makes LLM calls on this deployment's own provider key and can take a minute. You are usually the better reasoner: prefer pulling the handful of pages you need with \`query\` and \`get_page\` and reasoning yourself. Reach for \`synthesize\` only when a question genuinely spans more pages than you want to read into context, and say when you used it.

When the Brain genuinely has nothing on a question, say so rather than guessing. Cite Brain pages when you rely on them, so humans can verify.

## Contributing what you learned

Record what you learned by calling \`save_task_memory\` on the \`roomote\` server. Roomote redacts it and files it under this task's own entry.

Do this proactively, without being asked. Work whose findings are never recorded costs the next agent the same effort all over again, so an unremarkable memory is far better than a missing one. Default to saving, and skip only genuinely trivial work: a one-line change, a pure rename, a question you answered without investigating anything.

Record what the diff cannot show:
- what you decided and why, especially where you rejected an alternative
- facts about the codebase, systems, or tooling that took real effort to establish
- dead ends and wrong turns, so the next agent does not repeat them
- conventions, preferences, or corrections the user gave you
- what is still unresolved, or deliberately left undone

Work that ended without a fix is worth recording too. Knowing that an approach does not work, and why, is often the most useful thing a later task can inherit.

Call it as soon as the outcome is clear rather than saving it for the last moment. A later call replaces the earlier one, so you can refine the memory if more emerges.

Keep it concise and reusable: a few sentences a future agent can act on. Never include secrets or credentials, file contents or long code blocks, a step-by-step narration of what you did, or anything a future agent could read straight out of the repository or the pull request.`;
