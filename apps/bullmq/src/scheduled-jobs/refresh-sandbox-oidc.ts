import { refreshDueSandboxOidcTargets } from '@roomote/sdk/server';

export const refreshSandboxOidcJob = async () => {
  console.log('[refreshSandboxOidc] Starting sandbox OIDC refresh check...');

  try {
    const result = await refreshDueSandboxOidcTargets();

    console.log(
      `[refreshSandboxOidc] Completed: ${result.refreshedMachines} refreshed, ${result.cleanedMachines} cleaned, ${result.failedMachines} failed`,
    );
  } catch (error) {
    console.error('[refreshSandboxOidc] Job failed:', error);
    throw error;
  }
};
