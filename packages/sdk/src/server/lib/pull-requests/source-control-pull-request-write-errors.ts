/**
 * Mirrors SourceControlReadError in source-control-pull-request-reads.ts so
 * write callers can map client-addressable failures to HTTP statuses the same
 * way the read and mutation surfaces do.
 */
export class SourceControlWriteError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'SourceControlWriteError';
  }
}
