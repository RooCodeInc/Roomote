import {
  getEffectiveGitHubAppSlug,
  Schemas as GitHubSchemas,
} from '@roomote/github';
import { ROOMOTE_CANONICAL_GITHUB_MENTION } from '@roomote/types';

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isMention = (comment: {
  body: string;
  user: { login: string } | null;
}) => {
  if (!comment.user?.login) {
    return false;
  }

  // Deployments answer both their configured app slug and the canonical
  // `@roomote` alias that product copy advertises. GitHub only treats `@name`
  // as a mention when it stands alone; a bare substring check would also fire
  // on longer logins (`@<slug>-fan`) and emails (`grace@<slug>.example.com`).
  const handles = new Set([
    ROOMOTE_CANONICAL_GITHUB_MENTION.slice(1),
    getEffectiveGitHubAppSlug().toLowerCase(),
  ]);
  const mentionPattern = new RegExp(
    `(^|[^\\w.-])@(?:${[...handles].map(escapeRegExp).join('|')})(?![\\w-])`,
    'i',
  );

  return (
    mentionPattern.test(comment.body) &&
    !GitHubSchemas.isRoomoteGitHubLogin(comment.user.login)
  );
};
