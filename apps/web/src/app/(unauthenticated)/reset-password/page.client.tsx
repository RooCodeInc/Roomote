'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { authClient } from '@/lib/auth-client';
import {
  Alert,
  AlertCircle,
  AlertDescription,
  ArrowRight,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Spinner,
} from '@/components/system';

function getResetErrorMessage(error: { message?: string } | null | undefined) {
  return (
    error?.message || 'Unable to reset the password. Try a new reset link.'
  );
}

export function ResetPasswordPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const error = searchParams.get('error');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isInvalidToken = !token || error === 'INVALID_TOKEN';

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMessage(null);

    if (!token) {
      setErrorMessage('This reset link is invalid or expired.');
      return;
    }

    if (newPassword.length < 8) {
      setErrorMessage('Password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await authClient.resetPassword({
        newPassword,
        token,
      });

      if (result.error) {
        setErrorMessage(getResetErrorMessage(result.error));
        return;
      }

      router.replace('/sign-in?password_reset=1');
      router.refresh();
    } catch (resetError) {
      setErrorMessage(
        resetError instanceof Error
          ? resetError.message
          : 'Unable to reset the password. Try a new reset link.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="flex w-full items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Reset password</CardTitle>
          <CardDescription>
            Choose a new password for your Roomote account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isInvalidToken ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>
                This reset link is invalid or expired. Ask an admin to create a
                new password reset link.
              </AlertDescription>
            </Alert>
          ) : (
            <form className="space-y-3 mx-auto w-80" onSubmit={handleSubmit}>
              {errorMessage ? (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-1">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  secret={true}
                  passwordStrength
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  disabled={isSubmitting}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="confirm-password">Confirm password</Label>
                <Input
                  id="confirm-password"
                  secret={true}
                  match={newPassword}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  disabled={isSubmitting}
                />
              </div>

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? <Spinner /> : null}
                Reset password
                <ArrowRight />
              </Button>
            </form>
          )}
        </CardContent>
        {isInvalidToken ? (
          <CardFooter align="center">
            <Button asChild variant="outline">
              <Link href="/sign-in">Back to sign in</Link>
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </main>
  );
}
