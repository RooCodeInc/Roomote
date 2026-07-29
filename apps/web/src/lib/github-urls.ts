type GitHubRepoReference = {
  owner: string;
  repo: string;
};

const OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
const REPO_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;

/**
 * Parse a user-supplied reference to a GitHub repository. Accepts full URLs
 * (`https://github.com/owner/repo`, with or without protocol, trailing
 * `.git`, extra path segments, or a query string) and bare `owner/repo`
 * shorthand. Returns null for anything that does not identify a repository.
 */
export function parseGitHubRepoReference(
  value: string,
): GitHubRepoReference | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  let path = trimmed;

  const urlMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i,
  );

  if (urlMatch?.[1]) {
    path = urlMatch[1];
  } else if (/^(?:https?:\/\/|www\.)/i.test(trimmed)) {
    // A URL that is not github.com never identifies a GitHub repository.
    return null;
  }

  const withoutFragment = path.split('#')[0] ?? '';
  const withoutQuery = withoutFragment.split('?')[0] ?? '';
  const segments = withoutQuery.split('/').filter(Boolean);

  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/i, '');

  if (!owner || !repo) {
    return null;
  }

  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) {
    return null;
  }

  return { owner, repo };
}
