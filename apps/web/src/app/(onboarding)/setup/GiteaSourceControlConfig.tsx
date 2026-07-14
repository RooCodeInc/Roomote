import { InstructionUrl } from './ProviderSetupInstructions';

export function GiteaSourceControlInstructions({
  publicOrigin,
}: {
  publicOrigin: string;
}) {
  return (
    <div className="max-w-xl space-y-3 text-muted-foreground">
      <p className="font-semibold text-foreground">
        Configure the Gitea application.
      </p>
      <p className="text-sm">
        Add both redirect URIs below to the Gitea application. The first is for
        deployment authorization; the second is for linking individual Gitea
        accounts in Roomote.
      </p>
      <InstructionUrl
        heading="Deployment callback"
        url={`${publicOrigin}/api/source-control/gitea/oauth/callback`}
      />
      <InstructionUrl
        heading="Account linking callback"
        url={`${publicOrigin}/api/auth/oauth2/callback/gitea`}
      />
    </div>
  );
}
