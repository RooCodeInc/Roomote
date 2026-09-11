import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  executeGitLabTool,
  GitLabOperationError,
  type GitLabMcpContext,
} from './operations';
import {
  gitLabToolSchemas,
  gitLabWriteTools,
  type GitLabToolInput,
  type GitLabToolName,
} from './schemas';

function description(name: GitLabToolName) {
  if (name === 'get_file_contents') {
    return 'Read a UTF-8 file at an immutable commit, at most 1 MiB and 2000 lines, with continuation metadata.';
  }
  if (name === 'search_project_code') {
    return 'Search code in this connected project only. Requires instance support for blob search; no unscoped fallback.';
  }
  return `GitLab ${name.replaceAll('_', ' ')} in an active connected repository.`;
}

export function registerGitLabTools(
  server: McpServer,
  context: GitLabMcpContext,
) {
  for (const name of Object.keys(gitLabToolSchemas) as GitLabToolName[]) {
    server.registerTool(
      name,
      {
        description: description(name),
        inputSchema: gitLabToolSchemas[name],
        annotations: {
          readOnlyHint: !gitLabWriteTools.has(name),
          destructiveHint: gitLabWriteTools.has(name),
          openWorldHint: true,
        },
      },
      async (input: GitLabToolInput) => {
        try {
          return await executeGitLabTool(context, name, input);
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  error instanceof GitLabOperationError
                    ? error.message
                    : 'GitLab operation unavailable, unsupported, or outside the permitted scope. No successful result was received.',
              },
            ],
          };
        }
      },
    );
  }
}
