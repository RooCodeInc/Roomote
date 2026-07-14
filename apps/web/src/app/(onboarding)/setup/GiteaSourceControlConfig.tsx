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
        In Gitea 1.23 or newer, create an OAuth application for the dedicated
        service account. Set the callback URL below, then request read:user,
        read:repository, write:repository, write:issue, and read:organization
        scopes.
      </p>
      <InstructionUrl
        heading="Web redirect URI"
        url={`${publicOrigin}/api/source-control/gitea/oauth/callback`}
      />
    </div>
  );
}
