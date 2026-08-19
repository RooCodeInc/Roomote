/**
 * Read-only look at what the Brain actually holds, for the Settings page.
 *
 * Every other Brain surface either writes (the ingestion outbox and the
 * collectors) or proxies an agent's own call. This one asks the corpus what is
 * in it so an admin can see the thing instead of inferring it from Roomote's
 * ingestion checkpoints, which describe what was sent rather than what landed.
 *
 * It deliberately reports a *sample*, not a census. `list_pages` sorts by
 * recency and answers with a bounded window, so a deployment large enough to
 * exceed that window would have its composition chart quietly describe only
 * the newest slice. Rather than present that as a total, the snapshot carries
 * `truncated` and the UI says which it is.
 */

import { resolveBrainConnection } from './brain-clients';
import { callBrainTool } from './brain-mcp';

/** Upper bound requested from the Brain in one listing. */
const CORPUS_SAMPLE_LIMIT = 500;

/**
 * A settings page must not hold a request open on an unreachable service.
 * Short enough that an admin gets the rest of the page promptly; the corpus
 * section degrades to "unavailable" on its own.
 */
const CORPUS_REQUEST_TIMEOUT_MS = 8_000;

export type BrainCorpusPage = {
  slug: string;
  title: string | null;
  updatedAt: Date | null;
};

export type BrainCorpusSnapshot = {
  pages: BrainCorpusPage[];
  /** The listing filled the requested window, so more pages exist. */
  truncated: boolean;
};

function toDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toCorpusPage(entry: unknown): BrainCorpusPage | null {
  if (typeof entry === 'string') {
    return entry.trim()
      ? { slug: entry.trim(), title: null, updatedAt: null }
      : null;
  }

  if (typeof entry !== 'object' || entry === null) {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const slug = typeof record.slug === 'string' ? record.slug.trim() : '';

  if (!slug) {
    return null;
  }

  const title =
    typeof record.title === 'string' && record.title.trim()
      ? record.title.trim()
      : null;

  return {
    slug,
    title,
    // gbrain has used more than one name for a page's date across versions,
    // and the chart only needs the newest one that parses.
    updatedAt:
      toDate(record.updated_at) ??
      toDate(record.modified_at) ??
      toDate(record.effective_date) ??
      null,
  };
}

/**
 * Pull the page list out of whatever shape the tool answered with: a bare
 * array, an array wrapped under `pages`/`results`, or a newline-delimited text
 * block. Being generous here is the point — a corpus listing that fails to
 * parse would show an admin an empty Brain, which is the one wrong answer.
 */
export function extractBrainCorpusPages(
  payloads: unknown[],
): BrainCorpusPage[] {
  const pages = new Map<string, BrainCorpusPage>();

  const absorb = (entries: unknown[]) => {
    for (const entry of entries) {
      const page = toCorpusPage(entry);

      if (page && !pages.has(page.slug)) {
        pages.set(page.slug, page);
      }
    }
  };

  for (const payload of payloads) {
    if (Array.isArray(payload)) {
      absorb(payload);
      continue;
    }

    if (typeof payload === 'string') {
      absorb(payload.split('\n').map((line) => line.trim()));
      continue;
    }

    if (typeof payload === 'object' && payload !== null) {
      for (const key of ['pages', 'results', 'items']) {
        const nested = (payload as Record<string, unknown>)[key];

        if (Array.isArray(nested)) {
          absorb(nested);
        }
      }
    }
  }

  return [...pages.values()];
}

/**
 * Whether a listing failure could be the tool rejecting our arguments, as
 * opposed to the Brain being unreachable. Timeouts, aborts, and network
 * errors must not trigger the argument-shape fallback: retrying those doubles
 * the page's latency bound and masks the real failure.
 */
function isRetryableToolError(error: unknown): boolean {
  return (
    error instanceof Error &&
    !(error instanceof TypeError) &&
    error.name !== 'TimeoutError' &&
    error.name !== 'AbortError'
  );
}

/**
 * One settings-page view issues this read from both `brain.get` and the
 * browse dialog's listing, and React Query refocus refetches add more. The
 * sample is already a bounded snapshot, so serving the same snapshot for a
 * few seconds costs nothing and keeps the composition chart and the dialog
 * agreeing with each other. Failures are cached only briefly so a Brain
 * coming back is noticed on the next interaction.
 */
const CORPUS_CACHE_TTL_MS = 30_000;
const CORPUS_FAILURE_CACHE_TTL_MS = 5_000;

let corpusCache: {
  value: Promise<BrainCorpusSnapshot | null>;
  expiresAtMs: number;
} | null = null;

/** Drop the cached sample, so the next call re-reads the corpus. */
export function resetBrainCorpusSampleCache(): void {
  corpusCache = null;
}

async function fetchBrainCorpusSample(): Promise<BrainCorpusSnapshot | null> {
  const connection = await resolveBrainConnection('agent');

  if (!connection) {
    return null;
  }

  try {
    let payloads: unknown[];
    let usedFallback = false;

    try {
      payloads = await callBrainTool(
        connection,
        'list_pages',
        { limit: CORPUS_SAMPLE_LIMIT },
        { timeoutMs: CORPUS_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      if (!isRetryableToolError(error)) {
        throw error;
      }

      // The listing tool's arguments have changed shape between gbrain
      // versions. A default-window listing still describes the corpus, so
      // fall back to it rather than reporting the Brain as unreachable.
      payloads = await callBrainTool(
        connection,
        'list_pages',
        {},
        { timeoutMs: CORPUS_REQUEST_TIMEOUT_MS },
      );
      usedFallback = true;
    }

    const pages = extractBrainCorpusPages(payloads);

    return {
      pages,
      // The fallback listing used the tool's own default window, whose size
      // is unknown, so its result is presented as a recent sample rather
      // than risked as a total.
      truncated:
        pages.length >= CORPUS_SAMPLE_LIMIT ||
        (usedFallback && pages.length > 0),
    };
  } catch (error) {
    console.warn(
      `[brain] corpus listing failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }
}

/**
 * Sample the corpus with the read-only agent credential, or return null when
 * the Brain is unconfigured or unreachable. Never throws: an unreachable Brain
 * is a state the page renders, not an error that takes the page down with it.
 */
export async function readBrainCorpusSample(): Promise<BrainCorpusSnapshot | null> {
  const cached = corpusCache;

  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.value;
  }

  const value = fetchBrainCorpusSample().then((snapshot) => {
    if (snapshot === null && corpusCache?.value === value) {
      corpusCache = {
        value,
        expiresAtMs: Date.now() + CORPUS_FAILURE_CACHE_TTL_MS,
      };
    }

    return snapshot;
  });

  corpusCache = { value, expiresAtMs: Date.now() + CORPUS_CACHE_TTL_MS };

  return value;
}

export type BrainCorpusPageContent = BrainCorpusPage & {
  /** The page body as the Brain stores it, or null when it answered without one. */
  content: string | null;
};

/**
 * Pull a single page's body out of whatever shape `get_page` answered with.
 * The same generosity as the listing parser, for the same reason: a page that
 * fails to parse would read as an empty page, which is the one wrong answer.
 */
export function extractBrainPageContent(
  slug: string,
  payloads: unknown[],
): BrainCorpusPageContent | null {
  let title: string | null = null;
  let updatedAt: Date | null = null;
  let content: string | null = null;

  for (const payload of payloads) {
    if (typeof payload === 'string') {
      content ??= payload;
      continue;
    }

    if (typeof payload !== 'object' || payload === null) {
      continue;
    }

    const record = payload as Record<string, unknown>;
    const nested =
      typeof record.page === 'object' && record.page !== null
        ? (record.page as Record<string, unknown>)
        : record;

    // `compiled_truth` is the body key gbrain actually answers `get_page`
    // with (the maintenance job's synthesis reads rely on it); the rest are
    // tolerance for older or alternate renderings.
    for (const key of ['compiled_truth', 'content', 'markdown', 'text']) {
      const value = nested[key];

      if (typeof value === 'string' && value.trim()) {
        content ??= value;
        break;
      }
    }

    if (typeof nested.title === 'string' && nested.title.trim()) {
      title ??= nested.title.trim();
    }

    const page = toCorpusPage(nested);

    if (page?.updatedAt) {
      updatedAt ??= page.updatedAt;
    }
  }

  if (content === null && title === null) {
    return null;
  }

  return { slug, title, updatedAt, content };
}

/**
 * Read one page with the read-only agent credential, or return null when the
 * Brain is unconfigured, unreachable, or has no such page. Same non-throwing
 * contract as the corpus sample: absence is a state the dialog renders.
 */
export async function readBrainPage(
  slug: string,
): Promise<BrainCorpusPageContent | null> {
  const connection = await resolveBrainConnection('agent');

  if (!connection) {
    return null;
  }

  try {
    const payloads = await callBrainTool(
      connection,
      'get_page',
      { slug, fuzzy: false },
      { timeoutMs: CORPUS_REQUEST_TIMEOUT_MS },
    );

    return extractBrainPageContent(slug, payloads);
  } catch (error) {
    console.warn(
      `[brain] page read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return null;
  }
}
