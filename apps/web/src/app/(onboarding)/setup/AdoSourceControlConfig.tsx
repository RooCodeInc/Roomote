type AdoAuthMode = 'pat' | 'entra' | 'delegated';

export function AdoSourceControlConfig({
  authMode,
  onAuthModeChange,
}: {
  authMode: AdoAuthMode;
  onAuthModeChange: (mode: AdoAuthMode) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="font-semibold text-foreground">
        How should Roomote connect?
      </p>
      <div className="w-full flex flex-col gap-1">
        <button
          type="button"
          aria-pressed={authMode === 'delegated'}
          className={`cursor-pointer rounded-md border p-3 text-left ${authMode === 'delegated' ? 'border-foreground' : 'border-foreground/30 hover:border-foreground/60'}`}
          onClick={() => onAuthModeChange('delegated')}
        >
          <span className="block font-medium">
            Connect with your Microsoft account
          </span>
          <span className="text-sm text-muted-foreground">
            Use a delegated Azure DevOps account.
          </span>
        </button>
        <button
          type="button"
          aria-pressed={authMode === 'pat'}
          className={`cursor-pointer rounded-md border p-3 text-left ${authMode === 'pat' ? 'border-foreground' : 'border-foreground/30 hover:border-foreground/60'}`}
          onClick={() => onAuthModeChange('pat')}
        >
          <span className="block font-medium">Personal access token</span>
          <span className="text-sm text-muted-foreground">
            Fast setup, with the option to switch later.
          </span>
        </button>
        <button
          type="button"
          aria-pressed={authMode === 'entra'}
          className={`cursor-pointer rounded-md border p-3 text-left ${authMode === 'entra' ? 'border-foreground' : 'border-foreground/30 hover:border-foreground/60'}`}
          onClick={() => onAuthModeChange('entra')}
        >
          <span className="block font-medium">
            Microsoft Entra service principal
          </span>
          <span className="text-sm text-muted-foreground">
            Most long-lasting, but more complex.
          </span>
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
      <div className="max-w-xl space-y-3 text-sm text-muted-foreground">
        <p>
          Create a PAT for the Azure DevOps identity Roomote should use. Open
          Azure DevOps token settings:
        </p>
        <a
          href="https://dev.azure.com/_usersSettings/tokens"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-foreground underline"
        >
          Create an Azure DevOps personal access token
        </a>
        <p>
          Grant Code read and write access, plus permission to manage service
          hook subscriptions for the projects Roomote should access.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-3 text-sm text-muted-foreground">
      <p className="font-semibold text-foreground">
        Create a Microsoft Entra app.
      </p>
      <p>
        Open Azure App registrations, choose <strong>New registration</strong>,
        and create an app in the Microsoft tenant that can access your Azure
        DevOps organization.
      </p>
      <a
        href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold text-foreground underline"
      >
        Open Azure App registrations
      </a>
      {authMode === 'delegated' ? (
        <>
          <p>Under Authentication, add this Web redirect URI:</p>
          <p className="break-all">
            <code className="text-foreground">
              {publicOrigin}/api/auth/oauth2/callback/ado
            </code>
          </p>
          <p>
            Create a client secret, grant the Azure DevOps delegated permissions
            required by your organization, and grant admin consent if your
            tenant requires it.
          </p>
        </>
      ) : (
        <p>
          Create a client secret, add the application to the Azure DevOps
          organization, and grant it access to the projects and repositories
          Roomote should use.
        </p>
      )}
    </div>
  );
}

export type { AdoAuthMode };
