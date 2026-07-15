import { InstructionUrl } from './ProviderSetupInstructions';

export function BitbucketSourceControlCreation() {
  return (
    <>
      <p className="font-semibold">Create a new Bitbucket OAuth consumer.</p>
      <p className="text-sm text-muted-foreground">
        As an admin, in the{' '}
        <a
          href="https://developer.atlassian.com/console/myapps/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline underline-offset-4 hover:text-foreground"
        >
          Atlassian Developer Console
        </a>
        , Create App → OAuth 2.0 → Account-level. Then go to Permissions →
        Marketplace or custom app → Bitbucket API. Then go to Permissions → and
        grant account, repository:write, pullrequest:write, and webhook scopes.
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
