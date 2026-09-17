import { scoreTypeSafeRelevance } from '@roomote/cloud-agents/server/typesafe-judgment';
import { formatSingleLineLog } from '@roomote/types';

const LOG_PREFIX = '[Brain Rerank]';

/**
 * Only hybrid recall is reordered. `search` is the exact-token path an agent
 * picks for names and identifiers, where lexical rank is already the point.
 */
const RERANKED_TOOL_NAMES = new Set(['query']);

/**
 * Passages the judgment model calls relevant at or above this move ahead of
 * the rest, and passages at or below the floor move behind them. Everything
 * in between, and the order inside each group, stays exactly as gbrain ranked
 * it, so an unsure judgment never overrides retrieval. Starting values, not
 * tuned.
 */
const JUDGMENT_RELEVANT_MIN = 0.8;
const JUDGMENT_IRRELEVANT_MAX = 0.15;

/** Only the head of a long page is judged; the tail keeps gbrain's order. */
const MAX_JUDGED_PASSAGES = 40;
const MAX_PASSAGE_CHARS = 1_500;
/** Keeps one judgment request's state well under the model's input cap. */
const MAX_TOTAL_PASSAGE_CHARS = 56_000;
const MAX_QUERY_CHARS = 2_000;

const RELEVANCE_QUESTION =
  'Would a teammate searching company memory for the request want to read this passage, because it states facts, decisions, or context that bear on what the request asks (not merely sharing a keyword or topic)?';

type BrainSearchResult = {
  title?: unknown;
  chunk_text?: unknown;
};

type ToolCallResult = {
  content?: unknown;
  isError?: unknown;
};

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function parseQueryResults(result: unknown): BrainSearchResult[] | null {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const { content, isError } = result as ToolCallResult;

  if (isError === true || !Array.isArray(content)) {
    return null;
  }

  const first = content[0] as { type?: unknown; text?: unknown } | undefined;

  if (first?.type !== 'text' || typeof first.text !== 'string') {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(first.text);

    return Array.isArray(parsed) &&
      parsed.every((item) => item && typeof item === 'object')
      ? (parsed as BrainSearchResult[])
      : null;
  } catch {
    return null;
  }
}

function passageText(item: BrainSearchResult, maxChars: number): string {
  const title = typeof item.title === 'string' ? item.title : '';
  const body = typeof item.chunk_text === 'string' ? item.chunk_text : '';

  return truncate(title ? `Title: ${title}\n\n${body}` : body, maxChars);
}

/**
 * Reorders a Brain `query` result by the optional judgment model's relevance
 * probabilities before the agent sees it. Items are only moved, never dropped
 * or edited, so every slug, page id, and chunk id the agent cites survives.
 * Returns `undefined` to pass the upstream result through unchanged: another
 * tool, an error or unparseable result, fewer than two passages, no key
 * configured, a failed judgment, or no confident judgment that changes order.
 */
export async function rerankBrainQueryResult(call: {
  toolName: string;
  arguments: unknown;
  result: unknown;
}): Promise<unknown> {
  if (!RERANKED_TOOL_NAMES.has(call.toolName)) {
    return undefined;
  }

  const query = (call.arguments as { query?: unknown } | undefined)?.query;

  if (typeof query !== 'string' || !query.trim()) {
    return undefined;
  }

  const items = parseQueryResults(call.result);

  if (!items || items.length < 2) {
    return undefined;
  }

  const head = items.slice(0, MAX_JUDGED_PASSAGES);
  const passageChars = Math.min(
    MAX_PASSAGE_CHARS,
    Math.floor(MAX_TOTAL_PASSAGE_CHARS / head.length),
  );

  let scores: Map<string, number> | null;

  try {
    scores = await scoreTypeSafeRelevance({
      query: truncate(query, MAX_QUERY_CHARS),
      candidateKind: 'memory passage',
      relevanceQuestion: RELEVANCE_QUESTION,
      candidates: head.map((item, index) => ({
        id: String(index),
        text: passageText(item, passageChars),
      })),
    });
  } catch (error) {
    console.warn(
      formatSingleLineLog(`${LOG_PREFIX} Judgment failed; keeping order`, {
        passages: head.length,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return undefined;
  }

  if (!scores) {
    return undefined;
  }

  const tier = (index: number): number => {
    const probability = scores.get(String(index));

    if (probability === undefined) {
      return 1;
    }

    if (probability >= JUDGMENT_RELEVANT_MIN) {
      return 0;
    }

    return probability <= JUDGMENT_IRRELEVANT_MAX ? 2 : 1;
  };

  // Array#sort is stable, so gbrain's order holds inside each tier.
  const order = head.map((_, index) => index).sort((a, b) => tier(a) - tier(b));

  if (order.every((originalIndex, index) => originalIndex === index)) {
    return undefined;
  }

  const reordered = [
    ...order.map((index) => head[index]),
    ...items.slice(MAX_JUDGED_PASSAGES),
  ];
  const { content } = call.result as { content: unknown[] };

  return {
    ...(call.result as object),
    content: [
      {
        ...(content[0] as object),
        text: JSON.stringify(reordered, null, 2),
      },
      ...content.slice(1),
    ],
  };
}
