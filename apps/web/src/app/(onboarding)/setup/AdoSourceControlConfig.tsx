import { Blocks, PlugZap, UserCog, UserKey } from 'lucide-react';
import { InstructionUrl } from './ProviderSetupInstructions';

type AdoAuthMode = 'pat' | 'entra' | 'delegated';

export const DEFAULT_ADO_AUTH_MODE: AdoAuthMode = 'delegated';

export function AdoSourceControlConfig({
  authMode,
  onAuthModeChange,
}: {
  authMode: AdoAuthMode;
  onAuthModeChange: (mode: AdoAuthMode) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="font-semibold text-foreground">Choose a connection path:</p>
      <div className="w-full flex flex-col gap-1">
        <button
          type="button"
          aria-pressed={authMode === 'delegated'}
          className={`flex gap-2 items-start cursor-pointer rounded-md border px-4 py-3 text-left ${authMode === 'delegated' ? 'border-foreground' : 'border-foreground/30 hover:border-foreground/60'}`}
          onClick={() => onAuthModeChange('delegated')}
        >
          <PlugZap className="size-6 shrink-0 mt-1" />
          <div>
            <span className="block font-medium">
              Connect with your Microsoft account
            </span>
            <span className="text-sm text-muted-foreground">
              Easiest to start, recommended, if you have the permissions.
            </span>
          </div>
        </button>
        <button
          type="button"
          aria-pressed={authMode === 'pat'}
          className={`flex gap-2 items-start cursor-pointer rounded-md border px-4 py-3 text-left ${authMode === 'pat' ? 'border-foreground' : 'border-foreground/30 hover:border-foreground/60'}`}
          onClick={() => onAuthModeChange('pat')}
        >
          <UserKey className="size-6 shrink-0 mt-1" />
          <div>
            <span className="block font-medium">Personal access token</span>
            <span className="text-sm text-muted-foreground">
              Also quick, best if you have limited ADO permissions.
            </span>
          </div>
        </button>
        <button
          type="button"
          aria-pressed={authMode === 'entra'}
          className={`flex gap-2 items-start cursor-pointer rounded-md border px-4 py-3 text-left ${authMode === 'entra' ? 'border-foreground' : 'border-foreground/30 hover:border-foreground/60'}`}
          onClick={() => onAuthModeChange('entra')}
        >
          <Blocks className="size-6 shrink-0 mt-1" />
          <div>
            <span className="block font-medium">
              Microsoft Entra service principal
            </span>
            <span className="text-sm text-muted-foreground">
              Long-lasting, but more complex.
            </span>
          </div>
        </button>
      </div>
    </div>
  );
}

export function AdoSourceControlInstructions({
  authMode,
  publicOrigin,
}: {
  authMode: AdoAuthMode;
  publicOrigin: string;
}) {
  if (authMode === 'pat') {
    return (
      <div className="max-w-xl space-y-3 text-muted-foreground">
        <p className="font-semibold text-foreground">
          Create a personal access token (PAT)
        </p>
        <p className="text-sm">
          Go to your personal Azure settings (
          <UserCog className="inline size-4 ml-1" /> in the top right) →
          Personal Access Tokens → New Token. Grant Code read and write access,
          plus permission to manage service hook subscriptions for the projects
          Roomote should access.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-3 text-muted-foreground">
      <p className="font-semibold text-foreground">
        Create a Microsoft Entra app.
      </p>
      <p className="text-sm">
        Open{' '}
        <a
          href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-foreground underline"
        >
          Azure App registrations
        </a>{' '}
        → New registration → Create an app in the Microsoft tenant that can
        access your Azure DevOps organization. IF you've created an app for
        Teams, you can reuse it.
        <br />
        Make sure to add this Web Redirect URI:
      </p>

      <InstructionUrl
        heading="Web redirect URI"
        url={`${publicOrigin}/api/auth/oauth2/callback/ado`}
      />
    </div>
  );
}

export type { AdoAuthMode };
