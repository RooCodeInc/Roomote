import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
} from '@roomote/types';
import {
  hasUserDirectMessageIdentity,
  sendUserDirectMessage,
} from '@roomote/sdk/server';

import { sendCommunicationChannelPost } from './communication-channel-posts';

type MessageTaskRun = {
  id?: number;
  taskId?: string;
  actingUserId?: string | null;
  payload: unknown;
};

type ParsedDestination =
  | { kind: 'self'; provider: 'slack' | 'telegram' }
  | {
      kind: 'slack';
      slackTeamId: string;
      target: string;
      threadTs?: string;
    }
  | {
      kind: 'current';
      provider: 'slack' | 'teams' | 'telegram' | 'discord';
    };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function parseDestination(destination: string): ParsedDestination | null {
  const normalized = destination.trim();
  if (normalized === 'slack:me' || normalized === 'telegram:me') {
    return {
      kind: 'self',
      provider: normalized.startsWith('slack') ? 'slack' : 'telegram',
    };
  }

  const currentMatch = normalized.match(
    /^(slack|teams|telegram|discord):current$/u,
  );
  if (currentMatch?.[1]) {
    return {
      kind: 'current',
      provider: currentMatch[1] as 'slack' | 'teams' | 'telegram' | 'discord',
    };
  }

  const slackMatch = normalized.match(
    /^slack:([^:]+):(channel|member):([^:]+)(?::thread:(.+))?$/u,
  );
  if (!slackMatch?.[1] || !slackMatch[2] || !slackMatch[3]) return null;
  if (slackMatch[2] === 'member' && slackMatch[4]) return null;
  return {
    kind: 'slack',
    slackTeamId: slackMatch[1],
    target: slackMatch[3],
    ...(slackMatch[4] ? { threadTs: slackMatch[4] } : {}),
  };
}

export async function sendCommunicationMessage(params: {
  actingUserId: string;
  taskRun?: MessageTaskRun;
  destination: string;
  message: string;
}): Promise<Response> {
  const destination = parseDestination(params.destination);
  if (!destination) {
    return jsonResponse(
      {
        code: 'invalid_destination',
        error:
          'Use an exact destination returned by list_chat_destinations or a trusted current-destination reference.',
      },
      400,
    );
  }

  if (destination.kind === 'self') {
    if (
      !(await hasUserDirectMessageIdentity(
        destination.provider,
        params.actingUserId,
      ))
    ) {
      return jsonResponse(
        {
          code: 'recipient_not_linked',
          error: `The authenticated Roomote member does not have a linked ${destination.provider} direct-message identity.`,
          provider: destination.provider,
        },
        404,
      );
    }

    const delivered = await sendUserDirectMessage({
      provider: destination.provider,
      userId: params.actingUserId,
      text: params.message,
      logContext: 'roomote-mcp-chat-message',
    });
    return delivered
      ? jsonResponse({
          delivered: true,
          provider: destination.provider,
          destination: params.destination,
        })
      : jsonResponse(
          {
            code: 'delivery_failed',
            error: `${destination.provider} direct-message delivery failed; no message was confirmed as sent.`,
            provider: destination.provider,
          },
          502,
        );
  }

  if (destination.kind === 'current') {
    const taskRun = params.taskRun;
    const currentProvider = taskRun
      ? getCommunicationProviderFromTaskPayload(taskRun.payload)
      : null;
    const currentChannel = taskRun
      ? getCommunicationChannelFromTaskPayload(taskRun.payload)
      : null;
    if (
      !taskRun ||
      currentProvider !== destination.provider ||
      !currentChannel
    ) {
      return jsonResponse(
        {
          code: 'destination_not_authorized',
          error: `${destination.provider}:current is only available when it exactly matches this task's configured destination.`,
        },
        403,
      );
    }
    return sendCommunicationChannelPost({
      taskRun: {
        ...taskRun,
        id: taskRun.id ?? 0,
        taskId: taskRun.taskId ?? 'communication-run',
      },
      parsedBody: {
        channel: currentChannel,
        text: params.message,
        images: [],
      },
    });
  }

  const taskRun = params.taskRun ?? {
    id: 0,
    taskId: `member:${params.actingUserId}`,
    actingUserId: params.actingUserId,
    payload: {},
  };
  return sendCommunicationChannelPost({
    taskRun: {
      ...taskRun,
      id: taskRun.id ?? 0,
      taskId: taskRun.taskId ?? 'communication-run',
      actingUserId: params.actingUserId,
      payload: {
        communicationProvider: 'slack',
        communicationTeamId: destination.slackTeamId,
      },
    },
    parsedBody: {
      channel: destination.target,
      ...(destination.threadTs ? { threadTs: destination.threadTs } : {}),
      text: params.message,
      images: [],
    },
  });
}
