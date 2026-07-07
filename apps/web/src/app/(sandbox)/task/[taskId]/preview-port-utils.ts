import { SYSTEM_PORT_NAMES } from '@roomote/types';

/**
 * Returns true for ports that should be shown in the preview service list.
 */
export function shouldIncludeInPreviewServiceList(portName: string): boolean {
  return !SYSTEM_PORT_NAMES.has(portName.toUpperCase());
}

export function hasPreviewServiceListEntries(
  portNames: readonly string[],
): boolean {
  return portNames.some(shouldIncludeInPreviewServiceList);
}
