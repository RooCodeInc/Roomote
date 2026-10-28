/**
 * - `connected`: a Brain is configured, provisioned, and answering.
 * - `unreachable`: configured, but the corpus did not answer. Ingestion is
 *   holding its checkpoints; this is an outage, not data loss.
 * - `incomplete`: half-configured. A Brain without embeddings still answers
 *   keyword queries, which looks real while missing everything semantic, so
 *   it is reported as a fault rather than as a working Brain.
 * - `not_configured`: this deployment has no Brain.
 */
export type BrainStatus =
  | 'connected'
  | 'unreachable'
  | 'incomplete'
  | 'not_configured';

type BrainSettingsStatusInput = {
  configured: boolean;
  url: string | null;
  embeddingsAvailable: boolean;
  corpusReachable: boolean;
  provisioned: boolean;
};

const EMBEDDINGS_DETAIL =
  'Memory has no embeddings provider, so it can only match keywords. Configure a provider key, Cloudflare Workers AI, or an embeddings upstream to enable semantic recall.';

/**
 * Settings status for Memory. Semantic recall needs embeddings from a
 * provider key, a configured upstream, or Cloudflare Workers AI.
 */
export function resolveBrainSettingsStatus(input: BrainSettingsStatusInput): {
  status: BrainStatus;
  statusDetail: string | null;
} {
  if (!input.configured) {
    return {
      status: 'not_configured',
      statusDetail:
        'Memory is turned off for this deployment. Enable it to give agents shared memory.',
    };
  }

  if (!input.url) {
    return {
      status: 'incomplete',
      statusDetail:
        'A Memory provider key is set, but no Memory service URL is configured, so there is nowhere to store memories.',
    };
  }

  if (!input.embeddingsAvailable) {
    return { status: 'incomplete', statusDetail: EMBEDDINGS_DETAIL };
  }

  if (input.corpusReachable) {
    return { status: 'connected', statusDetail: null };
  }

  if (!input.provisioned) {
    return {
      status: 'incomplete',
      statusDetail:
        'Roomote has not been able to provision its Memory credentials yet. This resolves on its own once Memory has started.',
    };
  }

  return {
    status: 'unreachable',
    statusDetail:
      'Memory did not answer. Ingestion holds its position while it is down, so nothing is lost.',
  };
}
