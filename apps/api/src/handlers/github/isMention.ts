import { Env } from '@roomote/env';
import { Schemas as GitHubSchemas } from '@roomote/github';

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
      .includes(`@${Env.NEXT_PUBLIC_GITHUB_APP_SLUG.toLowerCase()}`) &&
    !GitHubSchemas.isRoomoteGitHubLogin(comment.user.login)
  );
};
