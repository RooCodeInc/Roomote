import { InstructionUrl } from './ProviderSetupInstructions';

export function BitbucketSourceControlCreation() {
  return (
    <>
      <p className="font-semibold">Create a new Bitbucket OAuth consumer.</p>
      <p className="text-sm text-muted-foreground">
        As an admin, open the Bitbucket workspace you want Roomote to access,
        then go to Workspace settings → Apps and features → OAuth consumers →
        Add consumer. See the{' '}
        <a
          href="https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline underline-offset-4 hover:text-foreground"
        >
          Bitbucket OAuth consumer instructions
        </a>
        . Grant account, repository:write, pullrequest:write, and webhook
        scopes.
      </p>
    </>
  );
}

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
        In Authorization, add the OAuth 2.0 type, with this URL:
      </p>
      <InstructionUrl
        heading="Callback URL"
        url={`${publicOrigin}/api/source-control/bitbucket/oauth/callback`}
      />
    </div>
  );
}
