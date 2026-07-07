import { parseHostNested } from './url-parser';
import {
  resolveRequest,
  type ResolvedRequest,
  type ResolverIdentifier,
} from '../services/resolver';
import { logger, escapeForLog } from './logger';

/**
 * Try nested URL fallback: parse host as a nested URL and resolve the outer sandbox.
 * Returns the resolution if the nested parse succeeds and the outer port has wildcard_prefix.
 * Only used in outer mode (no suffix configured).
 *
 * @param host - The hostname to parse as a nested URL
 * @param logContext - Optional prefix for log messages (e.g., 'HTTP', 'WebSocket', 'Auth callback')
 */
export async function tryNestedFallback(
  host: string,
  logContext?: string,
): Promise<ResolvedRequest | null> {
  const nested = parseHostNested(host);
  if (!nested.isValid) return null;

  const outerIdentifier: ResolverIdentifier = {
    taskId: nested.outerTaskId!,
  };

  const outerResolution = await resolveRequest(
    outerIdentifier,
    nested.outerPortName,
  );

  // Only allow if the outer port has wildcard_prefix enabled
  if (outerResolution.status === 'active' && outerResolution.wildcardPrefix) {
    const prefix = logContext ? `${logContext}: ` : '';
    logger.info(
      {
        host: escapeForLog(host),
        outerPortName: escapeForLog(nested.outerPortName),
        innerPrefix: escapeForLog(nested.innerPrefix),
      },
      `${prefix}Nested URL: routing to outer sandbox via wildcard port`,
    );
    return outerResolution;
  }

  return null;
}
