import { z } from 'zod';
import { Env } from '@roomote/env';

/**
 * PullRequest
 * gh pr view 8569 --repo Roomote/example-app --json id,number,title,body,author,state,url,headRefName,baseRefName,baseRefOid,headRefOid,mergeable,isDraft,closingIssuesReferences,createdAt,updatedAt
 */

export const pullRequestSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  author: z.object({
    is_bot: z.boolean(),
    login: z.string(),
  }),
  baseRefName: z.string(),
  baseRefOid: z.string().optional(),
  closingIssuesReferences: z.array(
    z.object({
      id: z.string(),
      number: z.number(),
      repository: z.object({
        id: z.string(),
        name: z.string(),
      }),
      url: z.string(),
    }),
  ),
  headRefName: z.string(),
  headRefOid: z.string(),
  isDraft: z.boolean(),
  mergeable: z.string(),
  state: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;

/**
 * Issue
 * gh issue view 8568 --repo Roomote/example-app --json number,title,body,author,state,url,createdAt,updatedAt,comments
 */

export const issueSchema = z.object({
  number: z.number(),
  state: z.string(),
  body: z.string(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: z.object({
    id: z.string().optional(),
    is_bot: z.boolean(),
    login: z.string(),
    name: z.string().optional(),
  }),
  comments: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      url: z.string(),
      isMinimized: z.boolean(),
      minimizedReason: z.string(),
      createdAt: z.string(),
      author: z.object({
        login: z.string(),
      }),
    }),
  ),
});

export type Issue = z.infer<typeof issueSchema>;

/**
 * Commit
 * gh pr view 1251 --repo Roomote/example-cloud --json commits --jq '.commits[] | {sha: .oid, message: .messageHeadline}'
 */

export const commitSchema = z.object({
  message: z.string(),
  sha: z.string(),
});

export type Commit = z.infer<typeof commitSchema>;

/**
 * ReviewComment
 * https://docs.github.com/en/rest/pulls/comments
 * gh api repos/Roomote/example-cloud/pulls/1413/comments
 * gh api repos/Roomote/example-cloud/pulls/comments/2476429021
 */
export const reviewCommentSchema = z.object({
  id: z.number(),
  url: z.string(),
  body: z.string(),
  path: z.string(),
  diff_hunk: z.string(),
  subject_type: z.string(), // line, file, etc
  commit_id: z.string(),
  user: z.object({
    id: z.number(),
    login: z.string(),
    type: z.string(), // User, Bot
  }),
  in_reply_to_id: z.number().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ReviewComment = z.infer<typeof reviewCommentSchema>;

export const isRoomoteGitHubLogin = (login: string) => {
  const normalizedLogin = login.toLowerCase();
  const appSlugs = new Set([
    Env.NEXT_PUBLIC_GITHUB_APP_SLUG.toLowerCase(),
    'roomote',
    'roomote-dev',
  ]);

  for (const appSlug of appSlugs) {
    if (
      normalizedLogin === `${appSlug}[bot]` ||
      normalizedLogin === `app/${appSlug}`
    ) {
      return true;
    }
  }

  return (
    normalizedLogin.startsWith('roomote-') ||
    normalizedLogin.startsWith('app/roomote-')
  );
};

export const isRoomoteCommentAuthor = (user: { login: string; type: string }) =>
  isRoomoteGitHubLogin(user.login);

export const isValidReviewComment = (comment: ReviewComment) =>
  isRoomoteCommentAuthor(comment.user) || comment.user.type === 'User';

/**
 * IssueComment
 * https://docs.github.com/en/rest/issues/comments
 * gh api repos/Roomote/example-cloud/issues/1413/comments
 * gh api repos/Roomote/example-cloud/issues/comments/3466016938
 */

export const issueCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  url: z.string(),
  user: z.object({
    id: z.number(),
    login: z.string(),
    type: z.string(), // User, Bot
  }),
  created_at: z.string(),
  updated_at: z.string(),
});

export type IssueComment = z.infer<typeof issueCommentSchema>;

export const isValidIssueComment = (comment: IssueComment) =>
  isRoomoteCommentAuthor(comment.user) || comment.user.type === 'User';

export type TriggeringComment =
  | {
      commentType: 'review';
      comment: ReviewComment;
      inReplyTo: ReviewComment | undefined;
    }
  | {
      commentType: 'issue';
      comment: IssueComment;
    }
  | {
      commentType: 'manual';
      comment: string;
    };
