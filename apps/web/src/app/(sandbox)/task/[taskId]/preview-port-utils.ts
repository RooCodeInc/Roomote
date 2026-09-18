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

/** Turns a configured port name like `WEB_APP` into a display label. */
export function humanizePortName(portName: string): string {
  return portName
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
