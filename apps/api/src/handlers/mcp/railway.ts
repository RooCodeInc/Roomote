import { redactSecrets } from '@roomote/communication/redact-secrets';
import { z } from 'zod';

import {
  McpProxyError,
  toMcpToolResult,
  type LocalMcpTool,
} from './proxy-utils';

const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_MESSAGE_LENGTH = 8_000;
const MAX_OUTPUT_LENGTH = 200_000;

const resourceIdSchema = z.string().trim().min(1).max(200);
const inputSchema = z
  .object({
    deploymentId: resourceIdSchema.optional(),
    projectId: resourceIdSchema.optional(),
    serviceId: resourceIdSchema.optional(),
    environmentId: resourceIdSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
    filter: z.string().trim().max(500).optional(),
    startDate: z.string().datetime({ offset: true }).optional(),
    endDate: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((value, context) => {
    if (
      !value.deploymentId &&
      !(value.projectId && value.serviceId && value.environmentId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Provide deploymentId or projectId, serviceId, and environmentId.',
      });
    }
  });

type RailwayLog = {
  timestamp?: string;
  message?: string;
  severity?: string;
};

type RailwayLogsResponse = {
  data?: { deploymentLogs?: RailwayLog[] | null } | null;
  errors?: Array<{ message?: string }>;
};

type RailwayDeploymentsResponse = {
  data?: {
    deployments?: { edges?: Array<{ node?: { id?: string } }> } | null;
  } | null;
  errors?: Array<{ message?: string }>;
};

function normalizeAuthorization(authHeader: string | null): string {
  if (!authHeader) {
    throw new McpProxyError(401, 'Railway credentials are unavailable');
  }

  return authHeader.startsWith('Bearer ') ? authHeader : `Bearer ${authHeader}`;
}

function boundLogs(logs: RailwayLog[]) {
  const output: RailwayLog[] = [];
  let outputLength = 0;
  let truncated = false;

  for (const log of logs) {
    const rawMessage = typeof log.message === 'string' ? log.message : '';
    const redactedMessage = redactSecrets(rawMessage);
    const message = redactedMessage.slice(0, MAX_LOG_MESSAGE_LENGTH);
    const normalized = {
      timestamp: typeof log.timestamp === 'string' ? log.timestamp : undefined,
      message,
      severity: typeof log.severity === 'string' ? log.severity : undefined,
    };
    const nextLength = JSON.stringify(normalized).length;

    if (outputLength + nextLength > MAX_OUTPUT_LENGTH) {
      truncated = true;
      break;
    }

    output.push(normalized);
    outputLength += nextLength;
    truncated ||= message.length < redactedMessage.length;
  }

  return { logs: output, truncated };
}

async function railwayGraphql<T>(
  authorization: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(RAILWAY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Railway API returned HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

export const railwayDeploymentLogsTool: LocalMcpTool = {
  definition: {
    name: 'get-deployment-logs',
    title: 'Get Railway Deployment Logs',
    description:
      'Fetch recent runtime logs for a Railway deployment, or the latest deployment of a service in an environment. Log messages are bounded and known credential patterns are redacted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deploymentId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Optional Railway deployment ID. When omitted, projectId, serviceId, and environmentId are required and only the latest matching deployment is used.',
        },
        projectId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Project ID used to resolve the latest deployment.',
        },
        serviceId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Service ID used to resolve the latest deployment.',
        },
        environmentId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Environment ID used to resolve the latest deployment.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Number of log rows to return. Defaults to 100.',
        },
        filter: {
          type: 'string',
          maxLength: 500,
          description: 'Optional Railway log filter expression.',
        },
        startDate: {
          type: 'string',
          format: 'date-time',
          description: 'Optional inclusive ISO 8601 start timestamp.',
        },
        endDate: {
          type: 'string',
          format: 'date-time',
          description: 'Optional inclusive ISO 8601 end timestamp.',
        },
      },
      anyOf: [
        { required: ['deploymentId'] },
        { required: ['projectId', 'serviceId', 'environmentId'] },
      ],
    },
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
  execute: async (args, credentials) => {
    const parsed = inputSchema.safeParse(args);
    if (!parsed.success) {
      throw new McpProxyError(
        400,
        parsed.error.issues[0]?.message ?? 'Invalid input',
      );
    }

    const authorization = normalizeAuthorization(credentials.authHeader);
    let deploymentId = parsed.data.deploymentId;

    if (!deploymentId) {
      const deploymentsPayload =
        await railwayGraphql<RailwayDeploymentsResponse>(
          authorization,
          `query LatestDeployment($input: DeploymentListInput!) {
          deployments(input: $input, first: 1) {
            edges { node { id } }
          }
        }`,
          {
            input: {
              projectId: parsed.data.projectId,
              serviceId: parsed.data.serviceId,
              environmentId: parsed.data.environmentId,
            },
          },
        );
      if (deploymentsPayload.errors?.length) {
        throw new Error(
          `Railway API rejected the deployment query: ${deploymentsPayload.errors[0]?.message ?? 'Unknown error'}`,
        );
      }
      deploymentId = deploymentsPayload.data?.deployments?.edges?.[0]?.node?.id;
      if (!deploymentId) {
        throw new McpProxyError(
          404,
          'No Railway deployment found for the selected service and environment',
        );
      }
    }

    const payload = await railwayGraphql<RailwayLogsResponse>(
      authorization,
      `query DeploymentLogs($deploymentId: String!, $limit: Int, $filter: String, $startDate: DateTime, $endDate: DateTime) {
          deploymentLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter, startDate: $startDate, endDate: $endDate) {
            timestamp
            message
            severity
          }
        }`,
      {
        deploymentId,
        limit: parsed.data.limit ?? DEFAULT_LOG_LIMIT,
        filter: parsed.data.filter,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
      },
    );
    if (payload.errors?.length) {
      throw new Error(
        `Railway API rejected the log query: ${payload.errors[0]?.message ?? 'Unknown error'}`,
      );
    }

    const { logs, truncated } = boundLogs(payload.data?.deploymentLogs ?? []);
    return toMcpToolResult({
      deploymentId,
      logs,
      truncated,
    });
  },
};
