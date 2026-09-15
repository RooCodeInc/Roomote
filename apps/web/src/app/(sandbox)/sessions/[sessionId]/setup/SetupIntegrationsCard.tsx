'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  MCP_INTEGRATIONS,
  SETUP_INTEGRATIONS,
  SETUP_INTEGRATIONS_CONTINUE_OPTION,
  SETUP_INTEGRATIONS_QUESTION_ID,
  type AcpRequestUserInputPayload,
} from '@roomote/types';

import { ArrowRight, Button, Plug } from '@/components/system';
import { Integrations } from '@/components/settings/Integrations';
import { McpIcon } from '@/components/settings/McpIcon';
import { useAuthorizedUser } from '@/hooks/useUser';
import { useTelemetry } from '@/hooks/useTelemetry';
import { useTRPC } from '@/trpc/client';

import {
  SetupSessionActionCard,
  SetupSessionActionCardActions,
} from './SetupSessionActionCard';

/**
 * A compact setup action card, intentionally matching the other cards in the
 * setup conversation. Detailed integration configuration reuses the shared
 * Settings surface without navigating away from the session.
 */
export function SetupIntegrationsCard({
  sessionId,
  request,
}: {
  sessionId: string;
  request: Pick<
    AcpRequestUserInputPayload,
    'requestId' | 'questions' | 'preset'
  >;
}) {
  const trpc = useTRPC();
  const { isAdmin } = useAuthorizedUser();
  const { enabled, capture } = useTelemetry();
  const [continued, setContinued] = useState(false);
  const [configurationRequest, setConfigurationRequest] = useState<{
    integrationId: string;
    sequence: number;
  } | null>(null);
  const nextConfigurationSequence = useRef(0);
  const shownRequest = useRef<string | null>(null);
  const skippedRequest = useRef<string | null>(null);

  const matchedIds = new Set(
    request.questions
      .find((question) => question.id === SETUP_INTEGRATIONS_QUESTION_ID)
      ?.options?.map((option) => option.id) ?? [],
  );
  const visibleIntegrations = SETUP_INTEGRATIONS.filter((integration) =>
    matchedIds.has(integration.id),
  );
  const matchedCount = visibleIntegrations.length;

  useEffect(() => {
    if (
      !enabled ||
      matchedCount === 0 ||
      shownRequest.current === request.requestId
    )
      return;
    shownRequest.current = request.requestId;
    capture('setup_integrations_shown', { matchedCount });
  }, [capture, enabled, matchedCount, request.requestId]);

  const submit = useMutation(
    trpc.setup.submitSessionUserInput.mutationOptions({
      onSuccess: () => {
        capture('setup_integrations_continued');
        setContinued(true);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const { mutate } = submit;

  useEffect(() => {
    if (matchedCount !== 0 || skippedRequest.current === request.requestId)
      return;
    skippedRequest.current = request.requestId;
    mutate({
      sessionId,
      requestId: request.requestId,
      answers: {
        [SETUP_INTEGRATIONS_QUESTION_ID]: {
          answers: [SETUP_INTEGRATIONS_CONTINUE_OPTION.label],
        },
      },
    });
  }, [matchedCount, mutate, request.requestId, sessionId]);

  if (continued) return null;

  const keepGoing = (
    <Button
      type="button"
      variant="outline"
      disabled={submit.isPending}
      onClick={() =>
        mutate({
          sessionId,
          requestId: request.requestId,
          answers: {
            [SETUP_INTEGRATIONS_QUESTION_ID]: {
              answers: [SETUP_INTEGRATIONS_CONTINUE_OPTION.label],
            },
          },
        })
      }
    >
      Keep going <ArrowRight />
    </Button>
  );
  const continuationError = submit.isError ? (
    <p role="alert" className="text-sm text-destructive">
      Couldn&apos;t continue setup. Please try again.
    </p>
  ) : null;

  if (matchedCount === 0) {
    return submit.isError ? (
      <div className="space-y-2">
        {continuationError}
        {keepGoing}
      </div>
    ) : null;
  }

  return (
    <>
      <SetupSessionActionCard
        title="Bring your team's tools along"
        icon={<Plug />}
        intro="Connect the tools you use so I can work with your team's context."
      >
        {!isAdmin ? (
          <p className="text-sm text-muted-foreground">
            An administrator can configure these connections.
          </p>
        ) : null}
        <ul
          className="divide-y divide-border"
          aria-label="Available integrations"
        >
          {visibleIntegrations.map((integration) => {
            const definition = MCP_INTEGRATIONS.find(
              (entry) => entry.id === integration.id,
            );
            return (
              <li key={integration.id} className="flex items-center gap-3 py-3">
                {definition ? (
                  <McpIcon icon={definition.icon} name={integration.name} />
                ) : null}
                <span className="min-w-0 flex-1 font-medium">
                  {integration.name}
                </span>
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Connect ${integration.name}`}
                  disabled={!isAdmin || submit.isPending}
                  onClick={() => {
                    capture('setup_integration_configuration_opened', {
                      integration_id: integration.id,
                    });
                    nextConfigurationSequence.current += 1;
                    setConfigurationRequest({
                      integrationId: integration.id,
                      sequence: nextConfigurationSequence.current,
                    });
                  }}
                >
                  Connect
                </Button>
              </li>
            );
          })}
        </ul>
        <SetupSessionActionCardActions>
          {keepGoing}
        </SetupSessionActionCardActions>
        {continuationError}
      </SetupSessionActionCard>
      <Integrations
        integrationIds={visibleIntegrations.map(
          (integration) => integration.id,
        )}
        configurationRequest={configurationRequest}
        showCatalog={false}
      />
    </>
  );
}
