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
      <p className="text-sm">Enter copy the redirect URL below:</p>
      <InstructionUrl
        heading="Web redirect URI"
        url={`${publicOrigin}/api/source-control/gitea/oauth/callback`}
      />
    </div>
  );
}
