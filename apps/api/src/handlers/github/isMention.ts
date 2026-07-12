import {
  getEffectiveGitHubAppSlug,
  Schemas as GitHubSchemas,
} from '@roomote/github';

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isMention = (comment: {
  body: string;
  user: { login: string } | null;
}) => {
  if (!comment.user?.login) {
    return false;
  }

  // GitHub only treats `@name` as a mention when it stands alone; a bare
  // substring check would also fire on longer logins (`@<slug>-fan`) and on
  // email addresses (`grace@<slug>.example.com`).
  const mentionPattern = new RegExp(
    `(^|[^\\w.-])@${escapeRegExp(getEffectiveGitHubAppSlug())}(?![\\w-])`,
    'i',
  );

  return (
    mentionPattern.test(comment.body) &&
    !GitHubSchemas.isRoomoteGitHubLogin(comment.user.login)
  );
};
