import { Button, Label, Spinner } from '@/components/system';

type AdoAuthMode = 'pat' | 'entra' | 'delegated';

export function AdoSourceControlConfig({
  authMode,
  linkedAccount,
  authenticate,
  authenticatePending,
  onAuthModeChange,
}: {
  authMode: AdoAuthMode;
  linkedAccount?: { displayName: string } | null;
  authenticate: () => void;
  authenticatePending: boolean;
  onAuthModeChange: (mode: AdoAuthMode) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>How should Roomote connect?</Label>
      <div className="w-full flex flex-col gap-1">
        <button
          type="button"
          aria-pressed={authMode === 'delegated'}
          className={`cursor-pointer rounded-md border p-3 text-left ${authMode === 'delegated' ? 'border-foreground' : 'border-foreground/30 hover:border-foreground/60'}`}
          onClick={() => onAuthModeChange('delegated')}
        >
          <span className="block font-medium">Connect with Microsoft</span>
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
            Fast setup, might might need switching later.
          </span>
        </button>
        <button
          type="button"
          aria-pressed={authMode === 'entra'}
          className={`cursor-pointer rounded-md border p-3 text-left ${authMode === 'entra' ? 'border-foreground' : 'border-foreground/30 hover:border-foreground/60'}`}
          onClick={() => onAuthModeChange('entra')}
        >
          <span className="block font-medium">Microsoft Entra app</span>
          <span className="text-sm text-muted-foreground">
            Most long-lasting, but more complex.
          </span>
        </button>
      </div>
      {authMode === 'delegated' ? (
        <div className="max-w-xl rounded-md border p-3 text-sm">
          <p className="text-muted-foreground">
            {linkedAccount
              ? `Connected as ${linkedAccount.displayName}.`
              : 'Connect the Azure DevOps account Roomote should use.'}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={authenticate}
            disabled={authenticatePending}
          >
            {authenticatePending ? <Spinner /> : null}
            {linkedAccount
              ? 'Reconnect with Microsoft'
              : 'Connect with Microsoft'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export type { AdoAuthMode };
