import { getOctokit } from '@roomote/github';
import { z } from 'zod';

import { McpProxyError, toMcpToolResult } from './proxy-utils';

/**
 * Native `enable_pull_request_auto_merge` tool for the GitHub MCP endpoint.
 *
 * GitHub's own MCP server has no auto-merge tool, so the endpoint answers this
 * one in-process under the same installation token a member's proxied calls
 * use. It mirrors the ADO/Gitea native merge handler conventions: the caller
 * binds the action to a freshly read head SHA, which the mutation passes to
 * GitHub as `expectedHeadOid` so a moved head is rejected atomically rather
 * than detected after the fact; GitHub enforces permissions, branch
 * protections, required checks, and allowed merge methods; and the pull
 * request is re-read after the mutation so success is only reported when
 * auto-merge is actually enabled at the expected head.
 */
export const ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL =
  'enable_pull_request_auto_merge';

const ownerSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/);
const repoSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+$/)
  .refine((value) => value !== '.' && value !== '..');
const shaSchema = z.string().regex(/^[a-fA-F0-9]{40}$/);

const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
type MergeMethod = (typeof MERGE_METHODS)[number];

const GRAPHQL_MERGE_METHODS: Record<MergeMethod, string> = {
  merge: 'MERGE',
  squash: 'SQUASH',
  rebase: 'REBASE',
};

const enablePullRequestAutoMergeArgsSchema = z
  .object({
    owner: ownerSchema,
    repo: repoSchema,
    pullNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedHeadSha: shaSchema,
    mergeMethod: z.enum(MERGE_METHODS).optional(),
  })
  .strict();

export const enablePullRequestAutoMergeToolDefinition = {
  name: ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL,
  description:
    'Enable auto-merge on an open GitHub pull request in an active connected repository. ' +
    'Only signed-in members may call it. Read the pull request immediately before calling and pass its current head SHA as expectedHeadSha; ' +
    'the mutation is bound to that head atomically on GitHub, so the call is rejected when the pull request is closed, already merged, or its head has moved, and a stale read is never acted on. ' +
    'GitHub enforces repository permissions, branch protections, required checks and reviews, and the merge methods the repository allows. ' +
    'The pull request is re-read after the mutation and success is only reported when auto-merge is actually enabled at the expected head.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      pullNumber: {
        type: 'number',
        description: 'Pull request number.',
      },
      expectedHeadSha: {
        type: 'string',
        description:
          'The 40-character head SHA from a pull request read taken immediately before this call. A mismatch rejects the call instead of acting on a stale pull request.',
      },
      mergeMethod: {
        type: 'string',
        enum: [...MERGE_METHODS],
        description:
          'Optional merge method GitHub applies when the pull request merges. Omit to use the repository default; an unsupported method is rejected.',
      },
    },
    required: ['owner', 'repo', 'pullNumber', 'expectedHeadSha'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

const autoMergeRequestSchema = z
  .object({
    mergeMethod: z.string().nullable().optional(),
    enabledAt: z.string().nullable().optional(),
    enabledBy: z
      .object({ login: z.string().nullable().optional() })
      .nullable()
      .optional(),
  })
  .nullable();

const autoMergeTargetSchema = z.object({
  repository: z
    .object({
      autoMergeAllowed: z.boolean().nullable().optional(),
      mergeCommitAllowed: z.boolean().nullable().optional(),
      squashMergeAllowed: z.boolean().nullable().optional(),
      rebaseMergeAllowed: z.boolean().nullable().optional(),
      pullRequest: z
        .object({
          id: z.string(),
          state: z.string(),
          merged: z.boolean().nullable().optional(),
          headRefOid: z.string(),
          url: z.string().nullable().optional(),
          autoMergeRequest: autoMergeRequestSchema,
        })
        .nullable(),
    })
    .nullable(),
});

const AUTO_MERGE_TARGET_QUERY = `query PullRequestAutoMergeTarget($owner: String!, $repo: String!, $pullNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    autoMergeAllowed
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    pullRequest(number: $pullNumber) {
      id
      state
      merged
      headRefOid
      url
      autoMergeRequest { mergeMethod enabledAt enabledBy { login } }
    }
  }
}`;

const ENABLE_AUTO_MERGE_MUTATION = `mutation EnablePullRequestAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod, $expectedHeadOid: GitObjectID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod, expectedHeadOid: $expectedHeadOid }) {
    pullRequest { autoMergeRequest { mergeMethod enabledAt enabledBy { login } } }
  }
}`;

type AutoMergeTarget = NonNullable<
  NonNullable<
    z.infer<typeof autoMergeTargetSchema>['repository']
  >['pullRequest']
>;

function mergeMethodAllowed(
  repository: NonNullable<z.infer<typeof autoMergeTargetSchema>['repository']>,
  mergeMethod: MergeMethod,
): boolean {
  switch (mergeMethod) {
    case 'merge':
      return repository.mergeCommitAllowed === true;
    case 'squash':
      return repository.squashMergeAllowed === true;
    case 'rebase':
      return repository.rebaseMergeAllowed === true;
  }
}

/**
 * GraphQL failures (permission denials, validation errors, branch-protection
 * rejections) must reach the caller with GitHub's own message instead of a
 * generic 500, so the model can report or correct the call.
 */
function toAutoMergeError(repositoryFullName: string, error: unknown): unknown {
  if (error instanceof McpProxyError) {
    return error;
  }
  const graphqlErrors =
    typeof error === 'object' && error !== null && 'errors' in error
      ? (error as { errors: unknown }).errors
      : undefined;
  if (Array.isArray(graphqlErrors) && graphqlErrors.length > 0) {
    const first = graphqlErrors[0] as { message?: unknown; type?: unknown };
    const message =
      typeof first?.message === 'string'
        ? first.message
        : error instanceof Error
          ? error.message
          : String(error);
    const status = first?.type === 'FORBIDDEN' ? 403 : 422;
    if (status !== 403 && /head/i.test(message)) {
      // GitHub rejects a moved expectedHeadOid with its own validation error;
      // surface it as the same stale-head signal the pre-read check uses.
      return new McpProxyError(
        409,
        `GitHub pull request in ${repositoryFullName} is not at the expected head SHA (${message}). Read it again before enabling auto-merge.`,
      );
    }
    return new McpProxyError(
      status,
      `GitHub could not enable auto-merge in ${repositoryFullName}: ${message}`,
    );
  }
  return error;
}

function toolError(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text:
          error instanceof McpProxyError
            ? error.message
            : 'GitHub auto-merge operation failed or returned an invalid response',
      },
    ],
  };
}

export async function callEnablePullRequestAutoMerge({
  token,
  repositoryFullName,
  arguments: rawArguments,
}: {
  token: string;
  repositoryFullName: string;
  arguments: unknown;
}): Promise<unknown> {
  try {
    const parsed = enablePullRequestAutoMergeArgsSchema.safeParse(rawArguments);
    if (!parsed.success) {
      throw new McpProxyError(
        400,
        `Invalid ${ENABLE_PULL_REQUEST_AUTO_MERGE_TOOL} arguments: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          )
          .join('; ')}`,
      );
    }
    const input = parsed.data;
    const octokit = getOctokit(token, { retryRateLimits: true });
    const variables = {
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullNumber,
    };
    const readTarget = async () => {
      const response = autoMergeTargetSchema.parse(
        await octokit.graphql(AUTO_MERGE_TARGET_QUERY, variables),
      );
      return response.repository;
    };

    const repository = await readTarget();
    const pullRequest = repository?.pullRequest;
    if (!repository || !pullRequest) {
      throw new McpProxyError(
        404,
        `GitHub pull request #${input.pullNumber} was not found in ${repositoryFullName}.`,
      );
    }
    if (pullRequest.state !== 'OPEN' || pullRequest.merged === true) {
      throw new McpProxyError(
        409,
        `GitHub pull request #${input.pullNumber} in ${repositoryFullName} is not open${
          pullRequest.merged === true ? ' (already merged)' : ''
        }; auto-merge can only be enabled on an open pull request.`,
      );
    }
    if (
      pullRequest.headRefOid.toLowerCase() !==
      input.expectedHeadSha.toLowerCase()
    ) {
      throw new McpProxyError(
        409,
        `GitHub pull request #${input.pullNumber} in ${repositoryFullName} is not at the expected head SHA. Read it again before enabling auto-merge.`,
      );
    }

    const buildResult = (target: AutoMergeTarget, alreadyEnabled: boolean) => ({
      result: {
        repositoryFullName,
        pullRequestNumber: input.pullNumber,
        url: target.url ?? null,
        headSha: target.headRefOid,
        alreadyEnabled,
        autoMerge: {
          enabled: true,
          mergeMethod: target.autoMergeRequest?.mergeMethod ?? null,
          enabledBy: target.autoMergeRequest?.enabledBy?.login ?? null,
        },
      },
    });

    if (pullRequest.autoMergeRequest) {
      return toMcpToolResult(buildResult(pullRequest, true));
    }

    if (repository.autoMergeAllowed !== true) {
      throw new McpProxyError(
        422,
        `GitHub repository ${repositoryFullName} does not allow auto-merge; enable it in the repository settings first.`,
      );
    }
    if (
      input.mergeMethod &&
      !mergeMethodAllowed(repository, input.mergeMethod)
    ) {
      throw new McpProxyError(
        422,
        `GitHub repository ${repositoryFullName} does not allow the ${input.mergeMethod} merge method.`,
      );
    }

    // expectedHeadOid makes GitHub itself reject the mutation when the head
    // moved after the pre-read, closing the read-then-mutate race atomically
    // on the provider side instead of only detecting it after the fact.
    await octokit.graphql(ENABLE_AUTO_MERGE_MUTATION, {
      pullRequestId: pullRequest.id,
      mergeMethod: input.mergeMethod
        ? GRAPHQL_MERGE_METHODS[input.mergeMethod]
        : null,
      expectedHeadOid: input.expectedHeadSha,
    });

    const verified = (await readTarget())?.pullRequest;
    if (!verified?.autoMergeRequest) {
      throw new McpProxyError(
        409,
        `GitHub accepted the auto-merge request for pull request #${input.pullNumber} in ${repositoryFullName} but has not confirmed it is enabled. Read the pull request again before retrying.`,
      );
    }
    if (
      verified.headRefOid.toLowerCase() !== input.expectedHeadSha.toLowerCase()
    ) {
      throw new McpProxyError(
        409,
        `Auto-merge was requested for pull request #${input.pullNumber} in ${repositoryFullName}, but its head moved to ${verified.headRefOid} during the call, so the result is ambiguous. Read the pull request again and re-apply at the current head if still intended.`,
      );
    }

    return toMcpToolResult(buildResult(verified, false));
  } catch (error) {
    return toolError(toAutoMergeError(repositoryFullName, error));
  }
}
