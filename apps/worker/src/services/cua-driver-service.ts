import YAML from 'yaml';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { EnvironmentComputerUse } from '@roomote/types';

const CUA_DRIVER_BINARY = '/usr/local/bin/cua-driver';
const SHARED_BROWSER_BINARY = '/opt/agent-browser/chrome';
const CUA_DRIVER_STATE_DIR = '/home/roomote/.roomote/cua-driver';
export const CUA_DRIVER_MANIFEST_PATH = join(
  CUA_DRIVER_STATE_DIR,
  'capabilities.yaml',
);

const CUA_DRIVER_BROWSER_TOOLS = [
  'start_session',
  'end_session',
  'list_apps',
  'list_windows',
  'browser_prepare',
  'get_browser_state',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_download',
] as const;

export function buildCuaDriverCapabilityManifest(
  config: EnvironmentComputerUse,
): string {
  return YAML.stringify({
    version: 3,
    expires_after: '8h',
    idle_timeout: '30m',
    allow: { tools: CUA_DRIVER_BROWSER_TOOLS },
    resources: {
      apps: [
        {
          executable: SHARED_BROWSER_BINARY,
          launch: false,
          windows: 'all',
        },
      ],
      browser: {
        profiles: [{ kind: 'existing_profile' }],
        origins: config.browser_origins,
      },
      desktop: { display: false },
    },
  });
}

/**
 * Enables the task-local MCP only when the pinned Driver binary and the
 * Shared Desktop it operates are both available. The MCP process itself is
 * owned by the harness, so normal task cancellation tears it down.
 */
export async function configureCuaDriver(params: {
  config: EnvironmentComputerUse;
  env: Record<string, string | undefined>;
}): Promise<boolean> {
  try {
    await access(CUA_DRIVER_BINARY);
  } catch {
    console.warn(
      'Cua Driver is unavailable because this worker image predates computer use support',
    );
    return false;
  }

  if (!params.env.DISPLAY || !params.env.ROOMOTE_DESKTOP_STREAM_PORT) {
    console.warn(
      'Cua Driver is unavailable because the Shared Desktop did not start',
    );
    return false;
  }

  await mkdir(dirname(CUA_DRIVER_MANIFEST_PATH), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    CUA_DRIVER_MANIFEST_PATH,
    buildCuaDriverCapabilityManifest(params.config),
    { mode: 0o600 },
  );

  params.env.ROOMOTE_CUA_DRIVER_MANIFEST_PATH = CUA_DRIVER_MANIFEST_PATH;
  params.env.ROOMOTE_CUA_DRIVER_BINARY = CUA_DRIVER_BINARY;
  params.env.ROOMOTE_CUA_DRIVER_HUMAN_CONTROL_URL = `http://127.0.0.1:${params.env.ROOMOTE_DESKTOP_STREAM_PORT}/metrics`;

  return true;
}
