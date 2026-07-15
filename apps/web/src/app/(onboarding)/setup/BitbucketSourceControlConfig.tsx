import { InstructionUrl } from './ProviderSetupInstructions';

export function BitbucketSourceControlInstructions({
  publicOrigin,
}: {
  publicOrigin: string;
}) {
  return (
    <div className="max-w-xl space-y-3 text-muted-foreground">
      <p className="font-semibold text-foreground">
        Configure the Bitbucket OAuth consumer.
      </p>
      <p className="text-sm">
        In Permissions, click “Add Marketplace or custom app”, add the
        “Bitbucket API”, then enable these OAuth scopes:
      </p>
      <ul className="list-disc pl-5 text-sm">
        <li>account</li>
        <li>repository</li>
        <li>repository:write</li>
        <li>pullrequest</li>
        <li>pullrequest:write</li>
        <li>webhook</li>
      </ul>
      <p className="text-sm">
        Add this callback URL to the OAuth consumer before saving it:
      </p>
      <InstructionUrl
        heading="Deployment callback"
        url={`${publicOrigin}/api/source-control/bitbucket/oauth/callback`}
      />
    </div>
  );
}
