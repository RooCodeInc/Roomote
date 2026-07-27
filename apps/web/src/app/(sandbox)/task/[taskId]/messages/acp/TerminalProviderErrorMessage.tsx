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
      className="flex items-start gap-2 py-1 text-sm text-destructive"
      data-testid="terminal-provider-error"
      role="alert"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">Provider error</p>
        <p
          className="text-foreground whitespace-pre-wrap wrap-break-word"
          data-testid="terminal-provider-error-summary"
        >
          {error.errorSummary}
        </p>
      </div>
    </div>
  );
}
