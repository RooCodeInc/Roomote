import { Button, CopyIconButton, ExternalLink } from '@/components/system';

export function GitLabSourceControlConfig({
  applicationsUrl,
  redirectUri,
}: {
  applicationsUrl: string;
  redirectUri: string;
}) {
  return (
    <div className="flex gap-2 items-start">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold">
          Recommended: create a GitLab OAuth application.
          <Button variant="outline" className="ml-2" asChild>
            <a href={applicationsUrl} target="_blank" rel="noopener noreferrer">
              Go <ExternalLink className="inline size-4 -mt-1 ml-1" />
            </a>
          </Button>
        </p>
        <p className="text-sm text-muted-foreground">
          Teammates can trigger Roomote from merge request comments only after
          linking their GitLab account, and that linking flow needs an OAuth
          application. Create one on the bot account (or as a group or
          instance-wide application), mark it confidential, select the{' '}
          <code>read_user</code> scope, and use this redirect URI:
        </p>
        <p className="flex items-center gap-1 text-sm text-muted-foreground">
          <code className="break-all text-foreground">{redirectUri}</code>
          <CopyIconButton content={redirectUri} tooltip="Copy redirect URI" />
        </p>
        <p className="text-sm text-muted-foreground">
          Then paste the generated Application ID and Secret into the OAuth
          fields below.
        </p>
      </div>
    </div>
  );
}
