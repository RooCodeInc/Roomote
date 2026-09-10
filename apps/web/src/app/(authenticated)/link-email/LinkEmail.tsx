'use client';

import { useSearchParams } from 'next/navigation';

import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Check,
  Mail,
  Skeleton,
} from '@/components/system';
import {
  useEmailLinkPreview,
  useLinkEmailAddress,
} from '@/hooks/linked-accounts';

const INVALID_LINK_MESSAGE =
  'This link is invalid or has expired. Send another email to get a fresh link.';

function LinkEmailShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[calc(var(--effective-viewport-height)*0.75)] max-w-lg items-center justify-center py-8">
      <Card className="w-full">{children}</Card>
    </div>
  );
}

function LinkEmailError({ message }: { message: string }) {
  return (
    <LinkEmailShell>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4" />
          Link email address
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-destructive">{message}</p>
      </CardContent>
    </LinkEmailShell>
  );
}

export function LinkEmail() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const preview = useEmailLinkPreview(token);
  const linkEmailAddress = useLinkEmailAddress();

  if (!token) {
    return <LinkEmailError message={INVALID_LINK_MESSAGE} />;
  }

  if (preview.isError) {
    return <LinkEmailError message={preview.error.message} />;
  }

  if (preview.isPending) {
    return (
      <LinkEmailShell>
        <CardHeader>
          <CardTitle>
            <Skeleton className="h-6 w-48" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-5 w-72" />
        </CardContent>
        <CardFooter align="end">
          <Skeleton className="h-9 w-36" />
        </CardFooter>
      </LinkEmailShell>
    );
  }

  if (linkEmailAddress.isSuccess) {
    const { emailAddress, redispatchedCount } = linkEmailAddress.data;

    return (
      <LinkEmailShell>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Check className="size-4 text-green-600" />
            Email address linked
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p>
            {redispatchedCount > 0
              ? `${emailAddress} is linked. ${redispatchedCount} earlier ${
                  redispatchedCount === 1 ? 'email is' : 'emails are'
                } being processed now — replies will arrive in your inbox.`
              : 'Linked. Emails from this address will now reach Roomote.'}
          </p>
        </CardContent>
      </LinkEmailShell>
    );
  }

  return (
    <LinkEmailShell>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4" />
          Link email address
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          Link <span className="font-medium">{preview.data.emailAddress}</span>{' '}
          to your Roomote account? Emails you send from this address will start
          tasks attributed to you.
        </p>
        {linkEmailAddress.isError && (
          <p className="text-destructive">{linkEmailAddress.error.message}</p>
        )}
      </CardContent>
      <CardFooter align="end">
        <Button
          onClick={() => linkEmailAddress.mutate({ token })}
          disabled={linkEmailAddress.isPending}
        >
          {linkEmailAddress.isPending ? 'Linking…' : 'Link email address'}
        </Button>
      </CardFooter>
    </LinkEmailShell>
  );
}
