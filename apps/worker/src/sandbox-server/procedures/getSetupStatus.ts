import {
  readEnvironmentSetupStatus,
  SETUP_STATUS_RELATIVE_PATH,
  type EnvironmentSetupStatus,
} from '../../commands/setup/workspace/setup-status';

import { publicProcedure } from '../trpc';

export interface SetupStatusResult {
  path: string;
  exists: boolean;
  status: EnvironmentSetupStatus | null;
}

/**
 * Read the workspace-visible environment setup status file so the task UI can
 * list per-command setup log files for the Logs panel.
 */
export const getSetupStatus = publicProcedure.query(
  ({ ctx }): SetupStatusResult => {
    const status = readEnvironmentSetupStatus(ctx.workingDirectory);

    return {
      path: SETUP_STATUS_RELATIVE_PATH,
      exists: status !== null,
      status,
    };
  },
);
