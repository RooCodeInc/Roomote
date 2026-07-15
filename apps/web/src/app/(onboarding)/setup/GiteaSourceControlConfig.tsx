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
        Add this redirect URI to the Gitea application for deployment
        authorization.
      </p>
      <InstructionUrl
        heading="Deployment callback"
        url={`${publicOrigin}/api/source-control/gitea/oauth/callback`}
      />
    </div>
  );
}
