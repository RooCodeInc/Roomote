import { LinearClient as LinearSDK, AgentActivitySignal } from '@linear/sdk';

import type {
  AgentActivity,
  AgentActivityResult,
  AgentSessionPlanStep,
  AgentSessionUpdateResult,
  LinearComment,
  LinearBrainIssuePage,
  LinearOrganization,
  LinearViewer,
} from './types';

/**
 * Wrapper around the Linear SDK with agent-specific methods.
 */
export class LinearClient {
  private client: LinearSDK;
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
    this.client = new LinearSDK({ accessToken });
  }

  /**
   * Get the authenticated viewer (app user in a workspace).
   */
  async getViewer(): Promise<LinearViewer> {
    const viewer = await this.client.viewer;
    return {
      id: viewer.id,
      name: viewer.name,
      email: viewer.email ?? undefined,
    };
  }

  /**
   * Get the organization the app is installed in.
   */
  async getOrganization(): Promise<LinearOrganization> {
    const org = await this.client.organization;
    return {
      id: org.id,
      name: org.name,
      urlKey: org.urlKey,
    };
  }

  /**
   * Read one bounded issue page for durable Brain ingestion. Comments are
   * fetched in the same GraphQL request so collection does not create an N+1
   * request pattern.
   */
  async listIssuesForBrain(input: {
    first: number;
    after?: string | null;
    orderBy?: 'createdAt' | 'updatedAt';
    createdBefore?: string | null;
    updatedAfter?: string | null;
    updatedBefore?: string | null;
  }): Promise<LinearBrainIssuePage> {
    const query = `
      query BrainIssues(
        $first: Int!
        $after: String
        $filter: IssueFilter
      ) {
        issues(
          first: $first
          after: $after
          orderBy: ${input.orderBy ?? 'updatedAt'}
          includeArchived: true
          filter: $filter
        ) {
          nodes {
            id
            identifier
            title
            description
            url
            priority
            priorityLabel
            estimate
            createdAt
            updatedAt
            startedAt
            completedAt
            canceledAt
            archivedAt
            dueDate
            state { name type }
            team { key name }
            project { name }
            cycle { name number }
            parent { id identifier title }
            creator { name }
            assignee { name }
            labels { nodes { name } }
            relations(first: 20) {
              nodes { type relatedIssue { id identifier title } }
              pageInfo { hasNextPage }
            }
            inverseRelations(first: 20) {
              nodes { type issue { id identifier title } }
              pageInfo { hasNextPage }
            }
            comments(last: 20, orderBy: createdAt) {
              nodes {
                id
                body
                createdAt
                updatedAt
                user { name }
                externalUser { name }
                botActor { name }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const response = await this.client.client.rawRequest(query, {
      first: Math.max(1, Math.min(input.first, 100)),
      after: input.after ?? null,
      filter:
        input.createdBefore || input.updatedAfter || input.updatedBefore
          ? {
              ...(input.createdBefore
                ? { createdAt: { lte: input.createdBefore } }
                : {}),
              ...(input.updatedAfter || input.updatedBefore
                ? {
                    updatedAt: {
                      ...(input.updatedAfter
                        ? { gte: input.updatedAfter }
                        : {}),
                      ...(input.updatedBefore
                        ? { lte: input.updatedBefore }
                        : {}),
                    },
                  }
                : {}),
            }
          : null,
    });
    const data = response.data as {
      issues?: {
        nodes?: Array<{
          id: string;
          identifier: string;
          title: string;
          description?: string | null;
          url: string;
          priority?: number | null;
          priorityLabel?: string | null;
          estimate?: number | null;
          createdAt: string;
          updatedAt: string;
          startedAt?: string | null;
          completedAt?: string | null;
          canceledAt?: string | null;
          archivedAt?: string | null;
          dueDate?: string | null;
          state?: { name: string; type: string } | null;
          team?: { key: string; name: string } | null;
          project?: { name: string } | null;
          cycle?: { name?: string | null; number: number } | null;
          parent?: {
            id: string;
            identifier: string;
            title: string;
          } | null;
          creator?: { name: string } | null;
          assignee?: { name: string } | null;
          labels?: { nodes?: Array<{ name: string }> };
          relations?: {
            nodes?: Array<{
              type: string;
              relatedIssue: { id: string; identifier: string; title: string };
            }>;
            pageInfo?: { hasNextPage?: boolean };
          };
          inverseRelations?: {
            nodes?: Array<{
              type: string;
              issue: { id: string; identifier: string; title: string };
            }>;
            pageInfo?: { hasNextPage?: boolean };
          };
          comments?: {
            nodes?: Array<{
              id: string;
              body: string;
              createdAt: string;
              updatedAt: string;
              user?: { name: string } | null;
              externalUser?: { name: string } | null;
              botActor?: { name: string } | null;
            }>;
          };
        }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    };
    const connection = data.issues;

    return {
      issues: (connection?.nodes ?? []).map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? null,
        url: issue.url,
        priority: issue.priority ?? null,
        priorityLabel: issue.priorityLabel ?? null,
        estimate: issue.estimate ?? null,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        startedAt: issue.startedAt ?? null,
        completedAt: issue.completedAt ?? null,
        canceledAt: issue.canceledAt ?? null,
        archivedAt: issue.archivedAt ?? null,
        dueDate: issue.dueDate ?? null,
        state: issue.state ?? null,
        team: issue.team ?? null,
        project: issue.project ?? null,
        cycle: issue.cycle
          ? { name: issue.cycle.name ?? null, number: issue.cycle.number }
          : null,
        parent: issue.parent ?? null,
        creator: issue.creator ?? null,
        assignee: issue.assignee ?? null,
        labels: (issue.labels?.nodes ?? [])
          .map((label) => label.name)
          .sort((a, b) => a.localeCompare(b)),
        relationships: [
          ...(issue.relations?.nodes ?? []).map((relation) => ({
            type: relation.type,
            direction: 'outbound' as const,
            issue: relation.relatedIssue,
          })),
          ...(issue.inverseRelations?.nodes ?? []).map((relation) => ({
            type: relation.type,
            direction: 'inbound' as const,
            issue: relation.issue,
          })),
        ],
        relationshipsTruncated:
          issue.relations?.pageInfo?.hasNextPage === true ||
          issue.inverseRelations?.pageInfo?.hasNextPage === true,
        comments: (issue.comments?.nodes ?? []).map((comment) => ({
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          author:
            comment.user?.name ??
            comment.externalUser?.name ??
            comment.botActor?.name ??
            null,
        })),
      })),
      pageInfo: {
        hasNextPage: connection?.pageInfo?.hasNextPage ?? false,
        endCursor: connection?.pageInfo?.endCursor ?? null,
      },
    };
  }

  /**
   * Emit an agent activity for a session.
   *
   * Agent activities are used to communicate progress to Linear:
   * - thought: Internal reasoning (shown as thinking indicator) - uses `body` field
   * - action: Taking an action (e.g., running commands) - uses `action`, `parameter`, optional `result` fields
   * - response: Final response to the user - uses `body` field
   * - error: An error occurred - uses `body` field
   * - elicitation: Requesting input from the user - uses `body` field
   */
  async emitActivity(
    sessionId: string,
    activity: AgentActivity,
  ): Promise<AgentActivityResult> {
    try {
      // Build content based on activity type - Linear has different field requirements
      let content: Record<string, unknown>;

      if (activity.type === 'action') {
        // Action activities require 'action' and 'parameter' fields, optional 'result'
        content = {
          type: 'action',
          action: activity.action ?? 'Processing',
          parameter: activity.parameter ?? activity.content ?? 'request',
          ...(activity.result !== undefined && { result: activity.result }),
        };
      } else {
        // All other activity types use 'body' field
        content = {
          type: activity.type,
          body: activity.content,
        };
      }

      // Add ephemeral flag if specified
      if (activity.ephemeral !== undefined) {
        content.ephemeral = activity.ephemeral;
      }

      // Add any additional metadata fields
      if (activity.metadata) {
        Object.assign(content, activity.metadata);
      }

      // Map signal string to SDK enum
      let signal: AgentActivitySignal | undefined;
      if (activity.signal === 'select') {
        signal = AgentActivitySignal.Select;
      } else if (activity.signal === 'auth') {
        signal = AgentActivitySignal.Auth;
      }

      // Use the SDK's built-in createAgentActivity method
      const result = await this.client.createAgentActivity({
        agentSessionId: sessionId,
        content,
        ...(signal && { signal }),
        ...(activity.signalMetadata && {
          signalMetadata: activity.signalMetadata,
        }),
      });

      // Just check success - don't fetch the activity details (causes extra query)
      if (result.success) {
        return { success: true };
      }

      return {
        success: false,
        error: 'Failed to emit activity',
      };
    } catch (error) {
      console.error('[LinearClient.emitActivity] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Emit a "thought" activity - shows agent is thinking/processing.
   * @param ephemeral - If true, the thought will be ephemeral (e.g., for reasoning)
   */
  async emitThought(
    sessionId: string,
    content: string,
    ephemeral?: boolean,
  ): Promise<AgentActivityResult> {
    return this.emitActivity(sessionId, {
      type: 'thought',
      content,
      ephemeral,
    });
  }

  /**
   * Emit an "action" activity - shows agent is taking an action.
   *
   * Linear's action activities require:
   * - action: verb describing what's happening (e.g., "Processing", "Searching")
   * - parameter: what the action is targeting (e.g., "your request", "weather data")
   * - result: (optional) outcome of the action
   */
  async emitAction(
    sessionId: string,
    action: string,
    parameter: string,
    result?: string,
  ): Promise<AgentActivityResult> {
    return this.emitActivity(sessionId, {
      type: 'action',
      content: '', // Not used for action type
      action,
      parameter,
      result,
    });
  }

  /**
   * Emit a "response" activity - final response to the user.
   */
  async emitResponse(
    sessionId: string,
    content: string,
  ): Promise<AgentActivityResult> {
    return this.emitActivity(sessionId, { type: 'response', content });
  }

  /**
   * Emit an "error" activity - something went wrong.
   */
  async emitError(
    sessionId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<AgentActivityResult> {
    return this.emitActivity(sessionId, { type: 'error', content, metadata });
  }

  /**
   * Emit an "elicitation" activity - request input from user.
   *
   * Supports signals:
   * - 'select': Present a list of options for the user to choose from
   * - 'auth': Request user to complete account linking before continuing
   *
   * For 'auth' signal, signalMetadata should include:
   * - url: The authentication URL for account linking
   * - userId: (optional) Linear user ID to restrict the auth prompt to
   * - providerName: (optional) Name of the auth provider (e.g., "Roomote")
   */
  async emitElicitation(
    sessionId: string,
    content: string,
    options?: {
      metadata?: Record<string, unknown>;
      signal?: 'select' | 'auth';
      signalMetadata?: Record<string, unknown>;
    },
  ): Promise<AgentActivityResult> {
    return this.emitActivity(sessionId, {
      type: 'elicitation',
      content,
      metadata: options?.metadata,
      signal: options?.signal,
      signalMetadata: options?.signalMetadata,
    });
  }

  /**
   * Update the external URL for an agent session.
   * This displays an "Open" button in Linear that links to the dashboard.
   * Pass null to remove the external URL.
   *
   * @deprecated Use updateSessionExternalUrls instead for multiple URLs with labels.
   */
  /**
   * The issue an agent session belongs to, for binding delegated work to it
   * after the webhook payload is gone. Null when Linear cannot resolve it.
   */
  async getAgentSessionIssue(sessionId: string): Promise<{
    id: string;
    identifier: string;
    title: string;
    url: string;
    description?: string;
  } | null> {
    try {
      const session = await this.client.agentSession(sessionId);
      const issue = await session.issue;
      if (!issue) {
        return null;
      }
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        ...(issue.description ? { description: issue.description } : {}),
      };
    } catch (error) {
      console.error(
        `[LinearClient.getAgentSessionIssue] Failed to load the issue for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async updateSessionExternalUrl(
    sessionId: string,
    externalUrl: string | null,
  ): Promise<AgentSessionUpdateResult> {
    try {
      const result = await this.client.agentSessionUpdateExternalUrl(
        sessionId,
        { externalLink: externalUrl },
      );

      return { success: result.success };
    } catch (error) {
      console.error('[LinearClient.updateSessionExternalUrl] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Update the external URLs for an agent session using the new externalUrls property.
   * This displays multiple labeled links in Linear's agent session UI.
   *
   * Note: Uses a raw GraphQL mutation since the SDK types may not yet reflect this API.
   *
   * @param sessionId - The Linear agent session ID
   * @param externalUrls - Array of external URL objects with label and url
   */
  async updateSessionExternalUrls(
    sessionId: string,
    externalUrls: Array<{ label: string; url: string }>,
  ): Promise<AgentSessionUpdateResult> {
    try {
      // Use the SDK's internal graphql client to make a raw mutation
      // since the TypeScript types may not yet include externalUrls
      const result = await this.client.updateAgentSession(sessionId, {
        externalUrls,
      } as Parameters<typeof this.client.updateAgentSession>[1]);

      return { success: result.success };
    } catch (error) {
      console.error('[LinearClient.updateSessionExternalUrls] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Update the plan (native todo list) for an agent session.
   * This displays a checklist in Linear's agent session UI.
   *
   * Note: The entire plan must be replaced on each update.
   */
  async updateSessionPlan(
    sessionId: string,
    plan: AgentSessionPlanStep[],
  ): Promise<AgentSessionUpdateResult> {
    try {
      const result = await this.client.updateAgentSession(sessionId, { plan });

      return { success: result.success };
    } catch (error) {
      console.error('[LinearClient.updateSessionPlan] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get a comment by ID including user information.
   */
  async getComment(
    commentId: string,
  ): Promise<{ success: boolean; userId?: string; error?: string }> {
    try {
      const comment = await this.client.comment({ id: commentId });
      const user = await comment.user;

      return {
        success: true,
        userId: user?.id,
      };
    } catch (error) {
      console.error('[LinearClient.getComment] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Create a comment on an issue.
   */
  async createIssueComment(
    issueId: string,
    body: string,
  ): Promise<{ success: boolean; commentId?: string; error?: string }> {
    try {
      const comment = await this.client.createComment({
        issueId,
        body,
      });

      if (comment.success) {
        const createdComment = await comment.comment;
        return {
          success: true,
          commentId: createdComment?.id,
        };
      }

      return {
        success: false,
        error: 'Failed to create comment',
      };
    } catch (error) {
      console.error('[LinearClient.createIssueComment] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get the underlying Linear SDK client for advanced operations.
   */
  get sdk(): LinearSDK {
    return this.client;
  }

  /**
   * Get all comments for an issue using Linear's GraphQL API.
   *
   * This fetches comments directly from the API rather than relying on
   * the webhook payload's previousComments, which may not include
   * external comments (e.g., from synced GitHub issues or Slack threads).
   *
   * @param issueId - The Linear issue ID
   * @returns Array of LinearComment objects sorted chronologically
   */
  async getIssueComments(issueId: string): Promise<{
    success: boolean;
    comments?: LinearComment[];
    error?: string;
  }> {
    try {
      const MAX_PAGES = 50; // Safety limit: 50 pages * 100 comments = 5000 comments max
      const allComments: LinearComment[] = [];
      let hasNextPage = true;
      let afterCursor: string | undefined;
      let page = 0;

      while (hasNextPage && page < MAX_PAGES) {
        page++;
        const query = `
          query IssueComments($issueId: String!, $after: String) {
            issue(id: $issueId) {
              comments(first: 100, after: $after, orderBy: createdAt) {
                nodes {
                  id
                  body
                  url
                  createdAt
                  user {
                    id
                    name
                    email
                  }
                  externalUser {
                    name
                  }
                  botActor {
                    name
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `;

        const response = await this.client.client.rawRequest(query, {
          issueId,
          after: afterCursor,
        });

        const data = response.data as {
          issue?: {
            comments?: {
              nodes?: Array<{
                id: string;
                body: string;
                url?: string;
                createdAt: string;
                user?: { id: string; name: string; email?: string };
                externalUser?: { name: string };
                botActor?: { name: string };
              }>;
              pageInfo?: {
                hasNextPage: boolean;
                endCursor?: string;
              };
            };
          };
        };

        const nodes = data?.issue?.comments?.nodes ?? [];

        for (const node of nodes) {
          // Build the user field - prefer the regular user, fall back to externalUser or botActor
          let user: LinearComment['user'];

          if (node.user) {
            user = {
              id: node.user.id,
              name: node.user.name,
              email: node.user.email,
            };
          } else if (node.externalUser) {
            // External users (from synced GitHub issues, Slack threads, etc.)
            // don't have a Linear user ID, so we use a synthetic one
            user = {
              id: `external:${node.id}`,
              name: node.externalUser.name,
            };
          } else if (node.botActor) {
            user = {
              id: `bot:${node.id}`,
              name: node.botActor.name,
            };
          }

          allComments.push({
            id: node.id,
            body: node.body,
            url: node.url,
            createdAt: node.createdAt,
            user,
          });
        }

        hasNextPage = data?.issue?.comments?.pageInfo?.hasNextPage ?? false;
        afterCursor = data?.issue?.comments?.pageInfo?.endCursor ?? undefined;
      }

      return { success: true, comments: allComments };
    } catch (error) {
      console.error('[LinearClient.getIssueComments] Error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get repository suggestions for an issue using Linear's GraphQL API.
   * Linear's issueRepositorySuggestions provides AI-powered suggestions for
   * which repositories might be relevant to an issue based on its content.
   *
   * @param issueId - The Linear issue ID
   * @param candidateRepositories - Array of candidate repositories to rank
   * @returns Array of repository suggestions with names and URLs
   */
  async getIssueRepositorySuggestions(
    issueId: string,
    candidateRepositories: Array<{ name: string; url: string }>,
  ): Promise<{
    success: boolean;
    suggestions?: Array<{ name: string; url: string }>;
    error?: string;
  }> {
    // If no candidate repositories provided, return early
    if (candidateRepositories.length === 0) {
      return {
        success: true,
        suggestions: [],
      };
    }

    try {
      // Use the GraphQL client directly for this query since the SDK
      // may not have this method exposed
      const query = `
        query IssueRepositorySuggestions($issueId: String!, $candidateRepositories: [CandidateRepository!]!) {
          issueRepositorySuggestions(issueId: $issueId, candidateRepositories: $candidateRepositories) {
            suggestions {
              name
              url
            }
          }
        }
      `;

      const response = await this.client.client.rawRequest(query, {
        issueId,
        candidateRepositories,
      });

      // Type assertion for the response
      const data = response.data as {
        issueRepositorySuggestions?: {
          suggestions?: Array<{ name: string; url: string }>;
        };
      };

      const suggestions = data?.issueRepositorySuggestions?.suggestions ?? [];

      return {
        success: true,
        suggestions,
      };
    } catch (error) {
      console.error(
        '[LinearClient.getIssueRepositorySuggestions] Error:',
        error,
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

/**
 * Create a new LinearClient instance.
 */
export function createLinearClient(accessToken: string): LinearClient {
  return new LinearClient(accessToken);
}
