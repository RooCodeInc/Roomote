import { type AppRouterInput, type AppRouterOutput, client } from './client';

export type LinearSessionConnection = NonNullable<
  AppRouterOutput['linearSessions']['findFirst']
>;

export const findFirst = () => client.linearSessions.findFirst.query();

export const hasActiveConnection = () =>
  client.linearSessions.hasActiveConnection.query();

export const emitAction = (
  sessionId: string,
  action: string,
  parameter: string,
  result?: string,
) =>
  client.linearSessions.emitAction.mutate({
    sessionId,
    action,
    parameter,
    result,
  });

export const emitThought = (
  sessionId: string,
  content: string,
  ephemeral?: boolean,
) =>
  client.linearSessions.emitThought.mutate({
    sessionId,
    content,
    ephemeral,
  });

export const emitResponse = (sessionId: string, content: string) =>
  client.linearSessions.emitResponse.mutate({ sessionId, content });

export const emitElicitation = (
  sessionId: string,
  content: string,
  options?: {
    signal?: 'select';
    signalMetadata?: Record<string, unknown>;
  },
) =>
  client.linearSessions.emitElicitation.mutate({
    sessionId,
    content,
    signal: options?.signal,
    signalMetadata: options?.signalMetadata,
  });

export const updateSessionPlan = (
  sessionId: string,
  plan: Array<{
    content: string;
    status: 'pending' | 'inProgress' | 'completed' | 'canceled';
  }>,
) => client.linearSessions.updateSessionPlan.mutate({ sessionId, plan });

export const drainLinearMessages = (
  options: AppRouterInput['linearSessions']['drainLinearMessages'],
) => client.linearSessions.drainLinearMessages.mutate(options);
