import { Blocks, Cog, PlugZap, UserCog, UserKey } from 'lucide-react';
import { ADO_ENTRA_REQUIRED_API_PERMISSIONS_TEXT } from '@roomote/types';

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
        If you&apos;ve already created a Microsoft Entra app for Teams in this
        tenant, you can reuse it{' '}
        <span className="font-semibold">
          after adding the Azure DevOps access below.
        </span>{' '}
        If not, open{' '}
        <a
          href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-foreground underline"
        >
          Azure App registrations
        </a>{' '}
        → New registration → Create an app in the Microsoft tenant that can
        access your Azure DevOps organization.
      </p>
      <p className="text-sm">
        Open the app&apos;s{' '}
        <span className="font-semibold text-foreground">API permissions</span> →
        Add a permission → Azure DevOps, and grant{' '}
        <span className="font-semibold text-foreground">
          {ADO_ENTRA_REQUIRED_API_PERMISSIONS_TEXT}
        </span>
        . Then{' '}
        <span className="font-semibold text-foreground">
          save the permissions
        </span>{' '}
        and grant admin consent for the tenant — Azure does not apply
        permissions until they are saved, and a missing one only shows up later
        as a 401 when Roomote syncs repositories.
      </p>
      {authMode === 'delegated' && (
        <>
          <p className="text-sm">
            In either case, add the specific web redirect URI below (under
            Authentication):
          </p>
          <InstructionUrl
            heading="Web redirect URI"
            url={`${publicOrigin}/api/auth/oauth2/callback/ado`}
          />
        </>
      )}
      {authMode === 'entra' && (
        <>
          <p className="text-sm">
            Then go to{' '}
            <a
              href="https://entra.microsoft.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AppAppsPreview"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-foreground underline"
            >
              Entra Enterprise Apps
            </a>{' '}
            → find the app you just created → copy the service principal object
            ID.
          </p>
          <p className="text-sm">
            In Azure DevOps, go to the organization →{' '}
            <Cog className="inline mx-1" /> Organization Settings → Users → Add
            users → paste the object ID.
            <br />
            Set the access to Basic, choose the right project/group membership →
            Add.
          </p>
        </>
      )}
    </div>
  );
}
