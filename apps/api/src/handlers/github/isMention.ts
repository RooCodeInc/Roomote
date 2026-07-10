import {
  getEffectiveGitHubAppSlug,
  Schemas as GitHubSchemas,
} from '@roomote/github';

export const isMention = (comment: {
  body: string;
  user: { login: string } | null;
}) => {
  if (!comment.user?.login) {
    return false;
  }

  return (
    comment.body
      .toLowerCase()
      .includes(`@${getEffectiveGitHubAppSlug().toLowerCase()}`) &&
    !GitHubSchemas.isRoomoteGitHubLogin(comment.user.login)
  );
};
