'use client';

import type { ReactNode } from 'react';

import { useRouter } from 'next/navigation';

import { Streamdown } from 'streamdown';

import {
  ArrowLeft,
  ArrowRight,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/system';
import { streamdownCodeCjkPlugins } from '@/components/ai-elements/streamdown-plugins';

type CloudActionConfirmationProps = {
  title: string;
  description: string;
  confirmLabel: string;
  cancelHref: string;
  onConfirm: () => void;
  isPending?: boolean;
  error?: string | null;
  variant?: 'default' | 'destructive';
};

type CloudActionMessageProps = {
  title: string;
  description: ReactNode;
  tone?: 'default' | 'destructive';
};

export function CloudActionMessage({
  title,
  description,
  tone = 'default',
}: CloudActionMessageProps) {
  return (
    <div className="flex items-center justify-center h-[calc(var(--effective-viewport-height)*0.75)]">
      <div className="text-center space-y-2">
        <p
          className={
            tone === 'destructive'
              ? 'text-destructive font-medium'
              : 'font-medium'
          }
        >
          {title}
        </p>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
    </div>
  );
}

export function CloudActionConfirmation({
  title,
  description,
  confirmLabel,
  cancelHref,
  onConfirm,
  isPending = false,
  error = null,
  variant = 'default',
}: CloudActionConfirmationProps) {
  const router = useRouter();

  return (
    <div className="flex items-center justify-center min-h-[calc(var(--effective-viewport-height)*0.75)] py-8 max-w-2xl mx-auto">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            <Streamdown
              className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              plugins={streamdownCodeCjkPlugins}
            >
              {description}
            </Streamdown>
          </div>

          {error && <p className="text-destructive font-medium">{error}</p>}
        </CardContent>

        <CardFooter align="end">
          <Button variant="outline" onClick={() => router.push(cancelHref)}>
            <ArrowLeft />
            Go back
          </Button>
          <Button
            variant={variant === 'destructive' ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? 'Processing…' : confirmLabel}
            {!isPending && <ArrowRight />}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
