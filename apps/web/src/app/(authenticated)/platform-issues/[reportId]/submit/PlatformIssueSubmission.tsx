'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';

import {
  ArrowLeft,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  CheckCircle2,
  SendHorizontal,
} from '@/components/system';
import { useTRPC } from '@/trpc/client';

type PlatformIssueSubmissionProps = {
  report: {
    id: string;
    title: string;
    summary: string;
    taskUrl: string;
    submittedAt: Date | null;
  };
};

export function PlatformIssueSubmission({
  report,
}: PlatformIssueSubmissionProps) {
  const trpc = useTRPC();
  const [submittedAt, setSubmittedAt] = useState(report.submittedAt);
  const [error, setError] = useState<string | null>(null);
  const submit = useMutation(
    trpc.platformIssueReports.submit.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          setSubmittedAt(result.submittedAt);
          return;
        }
        setError(result.error);
      },
      onError: () => {
        setError('Roomote could not receive this report. Please try again.');
      },
    }),
  );

  if (submittedAt) {
    return (
      <div className="mx-auto flex min-h-[calc(var(--effective-viewport-height)*0.75)] max-w-2xl items-center px-4 py-8 sm:px-6">
        <Card className="w-full">
          <CardHeader>
            <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <CheckCircle2 className="size-5" />
            </div>
            <CardTitle>Report sent to Roomote</CardTitle>
            <CardDescription>
              The Roomote team can now review the platform issue details.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button variant="outline" asChild>
              <Link href={report.taskUrl}>
                <ArrowLeft />
                Back to task
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[calc(var(--effective-viewport-height)*0.75)] max-w-2xl items-center px-4 py-8 sm:px-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Send this platform issue to Roomote?</CardTitle>
          <CardDescription>
            Nothing has been sent yet. Confirm to share the information shown
            below with the Roomote team.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Title
            </p>
            <p className="font-medium break-words">{report.title}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Details
            </p>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">
              {report.summary}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Task link
            </p>
            <p className="break-all text-muted-foreground">{report.taskUrl}</p>
          </div>
          {error ? (
            <p role="alert" className="font-medium text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
        <CardFooter
          align="between"
          className="max-sm:flex-col-reverse max-sm:items-stretch"
        >
          <Button variant="outline" asChild>
            <Link href={report.taskUrl}>
              <ArrowLeft />
              Cancel
            </Link>
          </Button>
          <Button
            onClick={() => {
              setError(null);
              submit.mutate({ reportId: report.id });
            }}
            disabled={submit.isPending}
          >
            <SendHorizontal />
            {submit.isPending ? 'Sending...' : 'Send to Roomote'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
