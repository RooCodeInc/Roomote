'use client';

import { type ChangeEvent, type FormEvent, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import {
  Button,
  Check,
  IdCard,
  ImageUp,
  Input,
  Label,
  Pencil,
  Spinner,
  Trash2,
  Avatar,
} from '@/components/system';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

import { Section } from './Section';

export type UserProfileSectionProfile = {
  email: string;
  imageUrl: string;
  name: string;
};

function getAuthErrorMessage(
  error: { message?: string } | null | undefined,
  fallback: string,
) {
  return error?.message || fallback;
}

export function UserProfileSection({
  canChangePassword = false,
  profile,
}: {
  canChangePassword?: boolean;
  profile: UserProfileSectionProfile;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const hasNameChange = trimmedName !== profile.name;
  const hasEmailChange = trimmedEmail !== profile.email;
  // Only show the Remove control for avatars uploaded through this app's
  // /api/avatars/ endpoint. OAuth-provider avatar URLs are not removable here
  // — the user would lose their provider-supplied picture with no way back.
  const hasUploadedAvatar = profile.imageUrl.startsWith('/api/avatars/');

  const handleAvatarSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    // Reset so re-selecting the same file fires change again.
    event.target.value = '';

    if (!file) {
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      toast.error('Image must be 2 MB or smaller.');
      return;
    }

    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/user/avatar', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(body?.error ?? 'Unable to upload image. Try again.');
        return;
      }

      toast.success('Profile picture updated.');
      router.refresh();
    } catch {
      toast.error('Unable to upload image. Try again.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveAvatar = async () => {
    setIsRemoving(true);

    try {
      const response = await fetch('/api/user/avatar', { method: 'DELETE' });

      if (!response.ok) {
        toast.error('Unable to remove image. Try again.');
        return;
      }

      toast.success('Profile picture removed.');
      router.refresh();
    } catch {
      toast.error('Unable to remove image. Try again.');
    } finally {
      setIsRemoving(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!hasNameChange && !hasEmailChange) {
      setIsEditing(false);
      return;
    }

    if (!trimmedName) {
      toast.error('Enter your name.');
      return;
    }

    setIsSubmitting(true);
    let nameUpdated = false;

    try {
      if (hasNameChange) {
        const result = await authClient.updateUser({ name: trimmedName });

        if (result.error) {
          toast.error(
            getAuthErrorMessage(result.error, 'Unable to change your name.'),
          );
          return;
        }

        nameUpdated = true;
      }

      if (hasEmailChange) {
        const result = await authClient.changeEmail({
          newEmail: trimmedEmail,
        });

        if (result.error) {
          toast.error(
            getAuthErrorMessage(result.error, 'Unable to change your email.'),
          );
          return;
        }
      }

      toast.success('Profile updated.');
      setIsEditing(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Unable to update profile.',
      );
    } finally {
      setIsSubmitting(false);
      if (nameUpdated) {
        router.refresh();
      }
    }
  };

  return (
    <Section
      icon={IdCard}
      title="Profile"
      action={
        !isEditing ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setIsEditing(true)}
          >
            <Pencil className="size-3.5" />
            Edit
          </Button>
        ) : null
      }
    >
      <div className="space-y-5">
        {!isEditing ? (
          <div className="flex items-start gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleAvatarSelected}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading || isRemoving}
              aria-label={
                hasUploadedAvatar
                  ? 'Replace profile picture'
                  : 'Upload profile picture'
              }
              className="group relative shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed"
            >
              <Avatar
                imageUrl={profile.imageUrl}
                name={profile.name}
                email={profile.email}
                size="lg"
                className="size-12 text-base"
              />
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/70 text-white transition-opacity',
                  isUploading || isRemoving
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
                )}
              >
                {isUploading || isRemoving ? (
                  <Spinner />
                ) : (
                  <ImageUp className="size-5 text-white" />
                )}
              </span>
            </button>
            <div className="space-y-3">
              <div className="min-w-0">
                <p className="text-muted-foreground text-xs font-medium">
                  Name
                </p>
                <p className="mt-1 truncate text-sm font-medium">
                  {profile.name}
                </p>
              </div>
              <div className="min-w-0">
                <p className="text-muted-foreground text-xs font-medium">
                  Email
                </p>
                <p className="mt-1 truncate text-sm">{profile.email}</p>
              </div>
              {canChangePassword ? (
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs font-medium">
                    Password
                  </p>
                  <p className="mt-1 truncate text-sm" aria-label="Password">
                    ••••••••
                  </p>
                </div>
              ) : null}
              {hasUploadedAvatar ? (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="link"
                    disabled={isUploading || isRemoving}
                    onClick={handleRemoveAvatar}
                  >
                    {isRemoving ? <Spinner /> : <Trash2 className="size-3.5" />}
                    Remove picture
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <form className="space-y-4 max-w-md" onSubmit={handleSubmit}>
            <p className="text-muted-foreground">
              Update your name or email. Your profile picture can be changed
              from the profile view.
            </p>
            <div className="space-y-1">
              <Label htmlFor="personal-name">Name</Label>
              <Input
                id="personal-name"
                autoComplete="name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={isSubmitting}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="personal-email">Email</Label>
              <Input
                id="personal-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={isSubmitting}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={isSubmitting}>
                {isSubmitting ? <Spinner /> : <Check />}
                Save changes
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isSubmitting}
                onClick={() => {
                  setName(profile.name);
                  setEmail(profile.email);
                  setIsEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </Section>
  );
}
