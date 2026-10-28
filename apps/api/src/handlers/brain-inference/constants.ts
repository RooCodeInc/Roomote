export const LOG_PREFIX = '[Brain Inference]';

/**
 * Sentinel chat-model id the Brain requests in gateway mode. It is not a
 * real provider model: the gateway answers it through the deployment's
 * helper model. An operator's `R_BRAIN_MODEL` still wins.
 */
export const BRAIN_HELPER_MODEL_ID = 'roomote/helper';

export const HELPER_SYNTHESIS_TIMEOUT_MS = 120_000;
export const HELPER_SYNTHESIS_DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/**
 * Embeddings for recall and chat for sourced synthesis. Narrower than the
 * task-sandbox gateway because this credential is a static deployment secret.
 */
export const BRAIN_ALLOWED_PATHS = new Set([
  '/v1/embeddings',
  '/v1/chat/completions',
  '/v1/responses',
]);

/** Never forwarded upstream: the Brain's gateway token is not a provider key. */
export const REQUEST_HEADER_DENYLIST = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

export const RESPONSE_HEADER_DENYLIST = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
]);
