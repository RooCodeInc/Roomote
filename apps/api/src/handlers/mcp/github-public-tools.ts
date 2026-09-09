import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/*
 * Native schema excerpts: MIT License, Copyright (c) 2025 GitHub
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Native input schemas transcribed from github/github-mcp-server v0.32.0:
// https://github.com/github/github-mcp-server/tree/f09dd5e77478a564999ca24992146bbcbec2dada/pkg/github/__toolsnaps__
// Keep these contracts pinned; public transport limitations belong in descriptions,
// not invented tool names or arguments. Connected discovery remains upstream-owned.
const repository = {
  owner: { type: 'string', description: 'Repository owner' },
  repo: { type: 'string', description: 'Repository name' },
};
const pagination = {
  page: {
    type: 'number',
    minimum: 1,
    description: 'Page number for pagination (min 1)',
  },
  perPage: {
    type: 'number',
    minimum: 1,
    maximum: 100,
    description: 'Results per page for pagination (min 1, max 100)',
  },
};
const order = {
  type: 'string',
  enum: ['asc', 'desc'],
  description: 'Sort order',
};
const publicLimits =
  ' Public github.com reads use anonymous REST, one page per call (page <= 1000), a 15-second deadline and a 2 MiB total response limit. Search requires one positive repo:owner/name qualifier. No authenticated retry.';

export const githubPublicTools: Tool[] = [
  {
    name: 'get_file_contents',
    description:
      "Get the contents of a file or directory from a GitHub repository. Public source reads support UTF-8 files at an exact path; missing refs or paths do not fall back. Files exceeding the response limit are not downloaded. Directory listings inherit GitHub's 1,000-entry cap." +
      publicLimits,
    annotations: {
      readOnlyHint: true,
      title: 'Get file or directory contents',
    },
    inputSchema: {
      type: 'object',
      required: ['owner', 'repo'],
      properties: {
        owner: {
          type: 'string',
          description: 'Repository owner (username or organization)',
        },
        repo: repository.repo,
        path: {
          type: 'string',
          default: '/',
          description: 'Path to file/directory',
        },
        ref: {
          type: 'string',
          description:
            'Accepts optional git refs such as `refs/tags/{tag}`, `refs/heads/{branch}` or `refs/pull/{pr_number}/head`',
        },
        sha: {
          type: 'string',
          description:
            'Accepts optional commit SHA. If specified, it will be used instead of ref',
        },
      },
    },
  },
  {
    name: 'issue_read',
    description:
      'Get information about a specific issue in a GitHub repository.' +
      publicLimits,
    annotations: { readOnlyHint: true, title: 'Get issue details' },
    inputSchema: {
      type: 'object',
      required: ['method', 'owner', 'repo', 'issue_number'],
      properties: {
        ...repository,
        ...pagination,
        owner: { type: 'string', description: 'The owner of the repository' },
        repo: { type: 'string', description: 'The name of the repository' },
        issue_number: {
          type: 'number',
          description: 'The number of the issue',
        },
        method: {
          type: 'string',
          enum: ['get', 'get_comments', 'get_sub_issues', 'get_labels'],
          description:
            'The read operation to perform on a single issue.\nOptions are:\n1. get - Get details of a specific issue.\n2. get_comments - Get issue comments.\n3. get_sub_issues - Get sub-issues of the issue.\n4. get_labels - Get labels assigned to the issue.\n',
        },
      },
    },
  },
  {
    name: 'pull_request_read',
    description:
      'Get information on a specific pull request in GitHub repository. Public get_review_comments is unsupported because native review threads require authenticated GraphQL; get_comments reads ordinary discussion, not review threads.' +
      publicLimits,
    annotations: {
      readOnlyHint: true,
      title: 'Get details for a single pull request',
    },
    inputSchema: {
      type: 'object',
      required: ['method', 'owner', 'repo', 'pullNumber'],
      properties: {
        ...repository,
        ...pagination,
        pullNumber: { type: 'number', description: 'Pull request number' },
        method: {
          type: 'string',
          enum: [
            'get',
            'get_diff',
            'get_status',
            'get_files',
            'get_review_comments',
            'get_reviews',
            'get_comments',
            'get_check_runs',
          ],
          description:
            "Action to specify what pull request data needs to be retrieved from GitHub. \nPossible options: \n 1. get - Get details of a specific pull request.\n 2. get_diff - Get the diff of a pull request.\n 3. get_status - Get combined commit status of a head commit in a pull request.\n 4. get_files - Get the list of files changed in a pull request. Use with pagination parameters to control the number of results returned.\n 5. get_review_comments - Get review threads on a pull request. Each thread contains logically grouped review comments made on the same code location during pull request reviews. Returns threads with metadata (isResolved, isOutdated, isCollapsed) and their associated comments. Use cursor-based pagination (perPage, after) to control results.\n 6. get_reviews - Get the reviews on a pull request. When asked for review comments, use get_review_comments method.\n 7. get_comments - Get comments on a pull request. Use this if user doesn't specifically want review comments. Use with pagination parameters to control the number of results returned.\n 8. get_check_runs - Get check runs for the head commit of a pull request. Check runs are the individual CI/CD jobs and checks that run on the PR.\n",
        },
      },
    },
  },
  {
    name: 'list_pull_requests',
    description:
      'List pull requests in a GitHub repository. If the user specifies an author, then DO NOT use this tool and use the search_pull_requests tool instead.' +
      publicLimits,
    annotations: { readOnlyHint: true, title: 'List pull requests' },
    inputSchema: {
      type: 'object',
      required: ['owner', 'repo'],
      properties: {
        ...repository,
        ...pagination,
        base: { type: 'string', description: 'Filter by base branch' },
        head: {
          type: 'string',
          description: 'Filter by head user/org and branch',
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'Filter by state',
        },
        sort: {
          type: 'string',
          enum: ['created', 'updated', 'popularity', 'long-running'],
          description: 'Sort by',
        },
        direction: { ...order, description: 'Sort direction' },
      },
    },
  },
  {
    name: 'search_pull_requests',
    description:
      'Search for pull requests in GitHub repositories using issues search syntax already scoped to is:pr' +
      publicLimits,
    annotations: { readOnlyHint: true, title: 'Search pull requests' },
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        ...pagination,
        order,
        owner: {
          type: 'string',
          description:
            'Optional repository owner. If provided with repo, only pull requests for this repository are listed.',
        },
        repo: {
          type: 'string',
          description:
            'Optional repository name. If provided with owner, only pull requests for this repository are listed.',
        },
        query: {
          type: 'string',
          description: 'Search query using GitHub pull request search syntax',
        },
        sort: {
          type: 'string',
          description:
            'Sort field by number of matches of categories, defaults to best match',
          enum: [
            'comments',
            'reactions',
            'reactions-+1',
            'reactions--1',
            'reactions-smile',
            'reactions-thinking_face',
            'reactions-heart',
            'reactions-tada',
            'interactions',
            'created',
            'updated',
          ],
        },
      },
    },
  },
];
