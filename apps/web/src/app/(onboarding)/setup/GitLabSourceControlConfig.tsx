import { InstructionUrl } from './ProviderSetupInstructions';

export function GitLabSourceControlInstructions({
  publicOrigin,
}: {
  publicOrigin: string;
}) {
  return (
    <div className="max-w-xl space-y-3 text-muted-foreground">
      <p className="font-semibold text-foreground">
        Configure the GitLab OAuth application.
      </p>
      <p className="text-sm">Copy the redirect URL below into GitLab:</p>
      <InstructionUrl
        heading="Web redirect URI"
        url={`${publicOrigin}/api/source-control/gitlab/oauth/callback`}
      />
    </div>
  );
}
