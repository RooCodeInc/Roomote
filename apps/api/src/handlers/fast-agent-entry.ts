type FastAgentEntryMode = 'explicit' | 'default';

export type FastAgentStartResult =
  | { accepted: true; abort: () => Promise<void> }
  | { accepted: false; reason: string };

export function startAcceptedFastAgentTurn(input: {
  run: (callbacks: {
    onAccepted: (abort: () => Promise<void>) => void;
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
      onAccepted: (abort) => {
        if (settled) return;
        settled = true;
        settleAcceptance?.({ accepted: true, abort });
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
