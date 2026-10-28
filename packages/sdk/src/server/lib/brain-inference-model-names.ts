/**
 * Same model under each provider's naming, so a request can be translated
 * without changing which model actually runs. `kind` matters: a chat model
 * is free to be overridden per deployment, an embedding model is not,
 * because its output width is baked into the Brain's vector column at
 * creation.
 */
export const MODEL_TRANSLATIONS: ReadonlyArray<{
  kind: 'embedding' | 'chat';
  openai: string;
  openrouter: string;
}> = [
  {
    kind: 'embedding',
    openai: 'text-embedding-3-small',
    openrouter: 'openai/text-embedding-3-small',
  },
  {
    kind: 'embedding',
    openai: 'text-embedding-3-large',
    openrouter: 'openai/text-embedding-3-large',
  },
  { kind: 'chat', openai: 'gpt-5.6-luna', openrouter: 'openai/gpt-5.6-luna' },
];
