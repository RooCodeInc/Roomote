/**
 * True when a tRPC call failed because the Slack reply-target procedure does
 * not exist on the API, which identifies the supported N-1 rollback target.
 */
export function isMissingSlackReplyTargetProcedureError(
  error: unknown,
): boolean {
  if (!(error instanceof Error) || error.name !== 'TRPCClientError') {
    return false;
  }

  const data = (error as { data?: { code?: string } }).data;

  return (
    data?.code === 'NOT_FOUND' ||
    // Backstop for responses that lose the typed code after a proxy rewrite.
    /no .*procedure.* on path/i.test(error.message)
  );
}
