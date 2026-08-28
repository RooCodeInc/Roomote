import { db, eq, users } from '@roomote/db/server';

type FastAgentEntryMode = 'explicit' | 'default';

export type FastAgentStartResult =
  | { accepted: true }
  | { accepted: false; reason: string };

export function startAcceptedFastAgentTurn(input: {
  run: (callbacks: {
    onAccepted: () => void;
    onRejected: () => void;
  }) => Promise<unknown>;
  busyMessage?: string;
  onError: (error: unknown) => void;
}): Promise<FastAgentStartResult> {
  let settled = false;
  let settleAcceptance: ((result: FastAgentStartResult) => void) | undefined;
  const acceptance = new Promise<FastAgentStartResult>((resolve) => {
    settleAcceptance = resolve;
  });

  void input
    .run({
      onAccepted: () => {
        if (settled) return;
        settled = true;
        settleAcceptance?.({ accepted: true });
      },
      onRejected: () => {
        if (settled) return;
        settled = true;
        settleAcceptance?.({
          accepted: false,
          reason: input.busyMessage ?? 'Fast session is busy.',
        });
      },
    })
    .then(() => {
      if (!settled) {
        settled = true;
        settleAcceptance?.({
          accepted: false,
          reason: 'Fast session did not accept the request.',
        });
      }
    })
    .catch((error) => {
      if (!settled) {
        settled = true;
        settleAcceptance?.({
          accepted: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      input.onError(error);
    });

  return acceptance;
}

export function resolveFastAgentEntryMode(params: {
  explicitInvocation: boolean;
  userDefaultEnabled: boolean;
  fastAvailable?: boolean;
}): FastAgentEntryMode | null {
  if (params.explicitInvocation) {
    return 'explicit';
  }

  return params.userDefaultEnabled && params.fastAvailable !== false
    ? 'default'
    : null;
}

export async function hasCommunicationsFastModeDefault(
  userId: string,
): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { metadata: true },
  });
  const metadata = user?.metadata;

  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).communications_fast_mode_default ===
      true
  );
}
