import {
  sourceControlProviderSchema,
  type SourceControlProvider,
} from '@roomote/types';

const POSITIVE_INTEGER_PATTERN = /^\d+$/;

export function buildPullRequestFilterValue(input: {
  provider: SourceControlProvider;
  repository: string;
  number: number;
}) {
  return `${input.provider}:${input.repository}#${input.number}`;
}

export function parsePullRequestFilterValue(value: string) {
  const numberSeparator = value.lastIndexOf('#');
  if (numberSeparator <= 0) return null;

  const numberText = value.slice(numberSeparator + 1);
  if (!POSITIVE_INTEGER_PATTERN.test(numberText)) return null;

  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  const identity = value.slice(0, numberSeparator);
  const providerSeparator = identity.indexOf(':');

  if (providerSeparator > 0) {
    const providerResult = sourceControlProviderSchema.safeParse(
      identity.slice(0, providerSeparator),
    );
    const repository = identity.slice(providerSeparator + 1);
    if (providerResult.success) {
      return repository
        ? { provider: providerResult.data, repository, number }
        : null;
    }
  }

  return { provider: undefined, repository: identity, number };
}
