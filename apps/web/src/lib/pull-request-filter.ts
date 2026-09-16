import {
  sourceControlProviderSchema,
  type SourceControlProvider,
} from '@roomote/types';

const POSITIVE_INTEGER_PATTERN = /^\d+$/;

type ParsedPullRequestFilterValue = {
  provider?: SourceControlProvider;
  repository: string;
  number: number;
  repositoryId?: string;
  host?: string;
};

function parseFilterScope(scope: string | null) {
  if (!scope) return {};

  const [key, encodedValue] = scope.split(':', 2);
  if (!encodedValue || (key !== 'repositoryId' && key !== 'host')) return null;

  try {
    const decodedValue = decodeURIComponent(encodedValue);
    return key === 'repositoryId'
      ? { repositoryId: decodedValue }
      : { host: decodedValue };
  } catch {
    return null;
  }
}

export function buildPullRequestFilterValue(input: {
  provider: SourceControlProvider;
  repository: string;
  number: number;
  repositoryId?: string | null;
  host?: string | null;
}) {
  const identity = `${input.provider}:${input.repository}#${input.number}`;
  if (input.host) {
    return `${identity}|host:${encodeURIComponent(input.host)}`;
  }
  if (input.repositoryId) {
    return `${identity}|repositoryId:${encodeURIComponent(input.repositoryId)}`;
  }
  return identity;
}

export function parsePullRequestFilterValue(
  value: string,
): ParsedPullRequestFilterValue | null {
  const scopeSeparator = value.lastIndexOf('|');
  const identity = scopeSeparator > 0 ? value.slice(0, scopeSeparator) : value;
  const scope = scopeSeparator > 0 ? value.slice(scopeSeparator + 1) : null;
  const numberSeparator = identity.lastIndexOf('#');
  if (numberSeparator <= 0) return null;

  const numberText = identity.slice(numberSeparator + 1);
  if (!POSITIVE_INTEGER_PATTERN.test(numberText)) return null;

  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  const providerAndRepository = identity.slice(0, numberSeparator);
  const providerSeparator = providerAndRepository.indexOf(':');
  const parsedScope = parseFilterScope(scope);
  if (!parsedScope) return null;

  if (providerSeparator > 0) {
    const providerResult = sourceControlProviderSchema.safeParse(
      providerAndRepository.slice(0, providerSeparator),
    );
    const repository = providerAndRepository.slice(providerSeparator + 1);
    if (providerResult.success) {
      return repository
        ? {
            provider: providerResult.data,
            repository,
            number,
            ...parsedScope,
          }
        : null;
    }
  }

  return {
    provider: undefined,
    repository: providerAndRepository,
    number,
  };
}
