import { Settings } from '@/components/system';
import { InstructionUrl } from './ProviderSetupInstructions';

export function BitbucketSourceControlCreation() {
  return (
    <>
      <p className="font-semibold">Create a new Bitbucket OAuth Client.</p>
      <p className="text-sm text-muted-foreground">
        In the top right click the <Settings className="inline size-4 ml-0.5" />{' '}
        → Workspace settings → Apps and features → OAuth clients → Create OAuth
        client. In scopes, grant read + write for: account, repository,
        pullrequests and webhooks.
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
        Configure the OAuth callback.
      </p>
      <p className="text-sm">
        When creating the OAuth client, set the callback URL to:
      </p>
      <InstructionUrl
        heading="Callback URL"
        url={`${publicOrigin}/api/source-control/bitbucket/oauth/callback`}
      />
    </div>
  );
}
