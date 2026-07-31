import { getTerminalProviderErrorFromMessageData } from '@roomote/types';

import { AlertTriangle } from '@/components/system';

export function TerminalProviderErrorMessage({
  data,
}: {
  data: Record<string, unknown>;
}) {
  const error = getTerminalProviderErrorFromMessageData(data);

  if (!error) {
    return null;
  }

  return (
    <div
      className="min-w-0 text-sm text-destructive"
      data-testid="terminal-provider-error"
      role="alert"
    >
      <div className="flex min-w-0 items-center gap-2 py-1">
        <AlertTriangle className="size-3 shrink-0" />
        <p className="font-medium">Provider error</p>
      </div>
      <p
        className="ml-5 text-foreground whitespace-pre-wrap wrap-break-word"
        data-testid="terminal-provider-error-summary"
      >
        {error.errorSummary}
      </p>
    </div>
  );
}
