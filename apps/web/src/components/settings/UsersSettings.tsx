'use client';

import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useAuthorizedUser } from '@/hooks/useUser';
import { useTRPC } from '@/trpc/client';
import {
  AlertCircle,
  Avatar,
  Badge,
  BasicTooltip,
  BrandIcon,
  Button,
  CopyIconButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  KeyRound,
  Label,
  LucideLink,
  Mails,
  RotateCcwKey,
  ScrollText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Spinner,
  Trash2,
  Users,
} from '@/components/system';
import { Section } from '@/components/settings';
import { formatDistanceToNow } from 'date-fns';

function formatJoinedDate(value: Date | string | null): string {
  if (!value) {
    return '—';
  }

  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatFullDateTime(value: Date | string | null): string {
  if (!value) {
    return '—';
  }

  return new Date(value).toLocaleString();
}

function formatRelative(value: Date | string | null): string {
  if (!value) {
    return '—';
  }

  return formatDistanceToNow(new Date(value), { addSuffix: true });
}

export function UsersSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { userId: currentUserId, cloudEnabled } = useAuthorizedUser();
  const settingsQueryKey = trpc.accessPolicy.get.queryKey();
  const settingsQuery = useQuery(trpc.accessPolicy.get.queryOptions());
  const [label, setLabel] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [maxUses, setMaxUses] = useState('1');
  const [createdUrls, setCreatedUrls] = useState<Record<string, string>>({});
  const [pendingRemoval, setPendingRemoval] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [pendingPasswordReset, setPendingPasswordReset] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [passwordResetLink, setPasswordResetLink] = useState<{
    name: string;
    url: string;
    expiresAt: Date | string;
  } | null>(null);
  const [pendingInviteRemoval, setPendingInviteRemoval] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');

  const createInvite = useMutation(
    trpc.accessPolicy.createInvite.mutationOptions({
      onSuccess: async (result) => {
        setCreatedUrls((prev) => ({ ...prev, [result.inviteId]: result.url }));
        setLabel('');
        setInviteRole('member');
        setMaxUses('1');
        let successMessage = 'Invite link created and copied to the clipboard';
        try {
          await navigator.clipboard.writeText(result.url);
        } catch {
          successMessage =
            'Invite created. Copy the link before leaving this page.';
        }
        await queryClient.invalidateQueries({ queryKey: settingsQueryKey });
        toast.success(successMessage);
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
  const revokeInvite = useMutation(
    trpc.accessPolicy.revokeInvite.mutationOptions({
      onMutate: async ({ inviteId }) => {
        await queryClient.cancelQueries({ queryKey: settingsQueryKey });
        const previousSettings = queryClient.getQueryData(settingsQueryKey);

        queryClient.setQueryData(settingsQueryKey, (current) => {
          if (!current || typeof current !== 'object') {
            return current;
          }

          const settings = current as typeof settingsQuery.data;
          if (!settings) {
            return current;
          }

          return {
            ...settings,
            invites: settings.invites.map((invite) =>
              invite.id === inviteId
                ? { ...invite, revokedAt: new Date(), usable: false }
                : invite,
            ),
          };
        });

        return { previousSettings };
      },
      onSuccess: async () => {
        toast.success('Invite revoked.');
      },
      onError: (error, _input, context) => {
        if (context?.previousSettings) {
          queryClient.setQueryData(settingsQueryKey, context.previousSettings);
        }
        toast.error(error.message);
      },
      onSettled: async () => {
        await queryClient.invalidateQueries({ queryKey: settingsQueryKey });
      },
    }),
  );
  const updateUserRole = useMutation(
    trpc.accessPolicy.updateUserRole.mutationOptions({
      onSuccess: async () => {
        toast.success('Role updated.');
        await queryClient.invalidateQueries({ queryKey: settingsQueryKey });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
  const removeUser = useMutation(
    trpc.accessPolicy.removeUser.mutationOptions({
      onSuccess: async () => {
        toast.success('User removed.');
        setPendingRemoval(null);
        await queryClient.invalidateQueries({ queryKey: settingsQueryKey });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
  const setLicenseKey = useMutation(
    trpc.accessPolicy.setLicenseKey.mutationOptions({
      onSuccess: async (_result, variables) => {
        setLicenseKeyInput('');
        toast.success(
          variables.licenseKey ? 'License key saved.' : 'License key removed.',
        );
        await queryClient.invalidateQueries({ queryKey: settingsQueryKey });
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );
  const createPasswordResetLink = useMutation(
    trpc.accessPolicy.createPasswordResetLink.mutationOptions({
      onSuccess: async (result) => {
        const name = pendingPasswordReset?.name ?? 'this user';
        setPendingPasswordReset(null);
        setPasswordResetLink({
          name,
          url: result.url,
          expiresAt: result.expiresAt,
        });

        try {
          await navigator.clipboard.writeText(result.url);
          toast.success('Password reset link created and copied.');
        } catch {
          toast.success('Password reset link created.');
        }
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  if (settingsQuery.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <p>Failed to load user settings.</p>
      </div>
    );
  }

  const {
    slackTeamId,
    hasSlackSignIn,
    hasMicrosoftSignIn,
    invites,
    users: members,
    license,
  } = settingsQuery.data;
  const adminCount = members.filter((member) => member.role === 'admin').length;
  const visibleInvites = invites.filter((invite) => invite.revokedAt == null);
  const seatsRemaining = license.seatLimit - license.seatsUsed;
  const licenseBadge =
    license.status === 'valid' ? (
      <Badge variant="success">Licensed</Badge>
    ) : license.status === 'expired' ? (
      <Badge variant="warning">License expired</Badge>
    ) : license.status === 'invalid' ? (
      <Badge variant="destructive">Invalid license key</Badge>
    ) : (
      <Badge variant="secondary">Free tier</Badge>
    );

  const handleSaveLicenseKey = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

    const licenseKey = licenseKeyInput.trim();

    if (!licenseKey || setLicenseKey.isPending) {
      return;
    }

    setLicenseKey.mutate({ licenseKey });
  };

  const handleCreate = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

    if (createInvite.isPending) {
      return;
    }

    const parsedMaxUses = Number.parseInt(maxUses, 10);

    createInvite.mutate({
      label: label.trim() || undefined,
      role: inviteRole,
      maxUses: Number.isFinite(parsedMaxUses)
        ? Math.min(Math.max(parsedMaxUses, 1), 1000)
        : 1,
    });
  };

  return (
    <div className="space-y-6">
      {cloudEnabled ? null : (
        <Section icon={ScrollText} title="License">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              {licenseBadge}
              <p>
                {license.seatsUsed} of {license.seatLimit} seats used
                {license.licensee ? (
                  <span className="text-muted-foreground">
                    {' '}
                    · Licensed to {license.licensee}
                    {license.expiresAt
                      ? ` · Expires ${formatJoinedDate(license.expiresAt)}`
                      : ''}
                  </span>
                ) : null}
              </p>
            </div>

            {seatsRemaining <= 0 ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <p>
                  All seats are in use. New users cannot sign in until a seat is
                  freed or a license key with more seats is added.
                </p>
              </div>
            ) : seatsRemaining === 1 ? (
              <p className="text-sm text-muted-foreground">
                One seat remaining. Add a license key to raise the limit before
                inviting more users.
              </p>
            ) : null}

            {license.fromEnv ? (
              <p className="text-sm text-muted-foreground">
                License key is provided by the{' '}
                <span className="font-mono">R_LICENSE_KEY</span> environment
                variable. Update or remove that env var and restart the
                deployment to change it.
              </p>
            ) : (
              <form
                className="flex flex-col gap-3 md:flex-row md:items-end items-start max-w-2xl"
                onSubmit={handleSaveLicenseKey}
              >
                <div className="flex-1 space-y-2">
                  <Label htmlFor="license-key">License key</Label>
                  <Input
                    id="license-key"
                    value={licenseKeyInput}
                    placeholder="RMLK1.…"
                    onChange={(event) => setLicenseKeyInput(event.target.value)}
                    disabled={setLicenseKey.isPending}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={setLicenseKey.isPending || !licenseKeyInput.trim()}
                >
                  {setLicenseKey.isPending ? <Spinner /> : null}
                  Save key
                </Button>
                {license.status !== 'unlicensed' ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setLicenseKey.mutate({ licenseKey: null })}
                    disabled={setLicenseKey.isPending}
                  >
                    Remove key
                  </Button>
                ) : null}
              </form>
            )}
            <p className="text-sm text-muted-foreground">
              Deployments are free for up to {license.freeSeatLimit} users. A
              license key from the Roomote maintainers unlocks more seats. You
              can also set <span className="font-mono">R_LICENSE_KEY</span> in
              the deployment environment.
            </p>
          </div>
        </Section>
      )}

      <Section icon={Mails} title="Invites">
        <div className="space-y-2">
          <p>Sign up/sign in is currently available to:</p>
          {hasSlackSignIn ? (
            <div className="flex items-center gap-2 text-sm">
              <BrandIcon
                icon="slack"
                name="Slack"
                className="size-4 shrink-0"
              />
              <p>
                Any user in your Slack workspace
                {slackTeamId ? (
                  <span className="text-muted-foreground">
                    {' '}
                    ({slackTeamId})
                  </span>
                ) : null}
                .
              </p>
            </div>
          ) : null}
          {hasMicrosoftSignIn ? (
            <div className="flex items-center gap-2 text-sm">
              <BrandIcon
                icon="teams"
                name="Teams"
                className="size-4 shrink-0"
              />
              <p>Any user in your Microsoft Teams account can sign in.</p>
            </div>
          ) : null}
          <div className="flex items-center gap-2 text-sm">
            <KeyRound className="size-4 shrink-0" />
            <p>Users with an email and password</p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <LucideLink className="size-4 shrink-0" />
            <p>Anyone with an invite link</p>
          </div>
        </div>

        <div className="space-y-2 mt-8 mb-6">
          <h2 className="font-semibold mb-4">Create Invite</h2>
          <form
            className="flex flex-col gap-3 md:flex-row md:items-end items-start max-w-2xl"
            onSubmit={handleCreate}
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="invite-label">
                Label (eg team/person it&apos;s for)
              </Label>
              <Input
                id="invite-label"
                value={label}
                placeholder="e.g. Design team"
                onChange={(event) => setLabel(event.target.value)}
                disabled={createInvite.isPending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={inviteRole}
                onValueChange={(role) => {
                  if (role === 'admin' || role === 'member') {
                    setInviteRole(role);
                  }
                }}
                disabled={createInvite.isPending}
              >
                <SelectTrigger
                  id="invite-role"
                  className="w-28 m-0"
                  aria-label="Invite role"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-20 space-y-2">
              <Label htmlFor="invite-max-uses">Uses</Label>
              <Input
                id="invite-max-uses"
                type="number"
                min={1}
                max={1000}
                value={maxUses}
                onChange={(event) => setMaxUses(event.target.value)}
                disabled={createInvite.isPending}
              />
            </div>
            <Button type="submit" disabled={createInvite.isPending}>
              {createInvite.isPending ? <Spinner /> : null}
              Create invite
            </Button>
          </form>
          <p className="text-sm text-muted-foreground">
            Invites expire after 14 days.
          </p>
        </div>

        {visibleInvites.length > 0 ? (
          <div className="border-t border-background pt-3 divide-y divide-background">
            {visibleInvites.map((invite) => {
              const url = createdUrls[invite.id];
              return (
                <div
                  key={invite.id}
                  className="flex items-start gap-3 py-3 first:pt-0 last:pb-0 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate font-medium">
                      <span className="truncate">
                        {invite.label
                          ? `Invite for ${invite.label}`
                          : 'An Invite'}
                      </span>
                      {invite.role === 'admin' ? (
                        <Badge variant="secondary">Admin</Badge>
                      ) : null}
                      {!invite.usable ? (
                        <span className="text-xs text-muted-foreground">
                          {invite.revokedAt ? 'revoked' : 'expired or used up'}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {invite.usedCount} of {invite.maxUses} used · Created{' '}
                      <BasicTooltip
                        content={formatFullDateTime(invite.createdAt)}
                      >
                        <span>{formatRelative(invite.createdAt)}</span>
                      </BasicTooltip>{' '}
                      · Expires{' '}
                      <BasicTooltip
                        content={formatFullDateTime(invite.expiresAt)}
                      >
                        <span>{formatRelative(invite.expiresAt)}</span>
                      </BasicTooltip>
                    </p>
                    {url ? (
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 font-mono truncate text-xs">
                          <LucideLink className="size-3 mr-1.5 inline-block" />
                          {url}
                        </span>
                        <CopyIconButton
                          content={url}
                          aria-label="Copy invite link"
                        />
                      </div>
                    ) : null}
                  </div>
                  {invite.revokedAt == null ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      aria-label={`Revoke invite ${invite.label || invite.id}`}
                      onClick={() =>
                        setPendingInviteRemoval({
                          id: invite.id,
                          name: invite.label || invite.id,
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </Section>

      <Dialog
        open={pendingInviteRemoval != null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingInviteRemoval(null);
          }
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Delete invite</DialogTitle>
            <DialogDescription>
              Delete this invite? It doesn&apos;t affect anyone who has already
              used it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingInviteRemoval(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (pendingInviteRemoval) {
                  const inviteId = pendingInviteRemoval.id;
                  setPendingInviteRemoval(null);
                  revokeInvite.mutate({ inviteId });
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Section icon={Users} title="Users">
        <div className="divide-y divide-background">
          {members.map((member) => {
            const isSelf = member.id === currentUserId;
            const isLastAdmin = member.role === 'admin' && adminCount <= 1;
            const roleLockReason = isSelf
              ? 'You cannot change your own role.'
              : isLastAdmin
                ? 'Promote another admin before demoting the last one.'
                : null;
            const removeLockReason = isSelf
              ? 'You cannot remove yourself.'
              : isLastAdmin
                ? 'Promote another admin before removing the last one.'
                : null;
            const resetLockReason = member.hasCredentialAccount
              ? null
              : 'This user signs in with Slack, Teams, or another OAuth provider.';
            const resetButton = (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label={`Reset password for ${member.name || member.email}`}
                onClick={() =>
                  setPendingPasswordReset({
                    id: member.id,
                    name: member.name || member.email,
                  })
                }
                disabled={
                  resetLockReason != null || createPasswordResetLink.isPending
                }
              >
                <RotateCcwKey />
              </Button>
            );
            const removeButton = (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label={`Remove ${member.name || member.email}`}
                onClick={() =>
                  setPendingRemoval({
                    id: member.id,
                    name: member.name || member.email,
                  })
                }
                disabled={removeLockReason != null || removeUser.isPending}
              >
                <Trash2 />
              </Button>
            );
            const roleSelect = (
              <Select
                value={member.role}
                onValueChange={(role) => {
                  if (role === 'admin' || role === 'member') {
                    updateUserRole.mutate({ userId: member.id, role });
                  }
                }}
                disabled={roleLockReason != null || updateUserRole.isPending}
              >
                <SelectTrigger
                  size="sm"
                  className="w-28 shrink-0"
                  aria-label={`Role for ${member.name || member.email}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                </SelectContent>
              </Select>
            );

            return (
              <div
                key={member.id}
                className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <Avatar
                  imageUrl={member.imageUrl}
                  name={member.name}
                  email={member.email}
                  size="md"
                  alt={member.name || member.email}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">
                      {member.name || member.email}
                    </span>
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    <span>{member.email}</span>
                    {' · Joined '}
                    {formatJoinedDate(member.createdAt)}
                  </p>
                </div>
                {roleLockReason ? (
                  <BasicTooltip content={roleLockReason}>
                    <span>{roleSelect}</span>
                  </BasicTooltip>
                ) : (
                  roleSelect
                )}
                {removeLockReason ? (
                  <BasicTooltip content={removeLockReason}>
                    <span>{removeButton}</span>
                  </BasicTooltip>
                ) : (
                  removeButton
                )}
                {resetLockReason ? (
                  <BasicTooltip content={resetLockReason}>
                    <span>{resetButton}</span>
                  </BasicTooltip>
                ) : (
                  resetButton
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Dialog
        open={pendingPasswordReset != null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingPasswordReset(null);
          }
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Create password reset link</DialogTitle>
            <DialogDescription>
              Create a one-hour password reset link for{' '}
              <span className="font-semibold">
                {pendingPasswordReset?.name}
              </span>
              ? Send the link to them through your preferred channel.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingPasswordReset(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (pendingPasswordReset) {
                  createPasswordResetLink.mutate({
                    userId: pendingPasswordReset.id,
                  });
                }
              }}
              disabled={createPasswordResetLink.isPending}
            >
              {createPasswordResetLink.isPending ? (
                <>
                  <Spinner />
                  Creating...
                </>
              ) : (
                'Create link'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={passwordResetLink != null}
        onOpenChange={(open) => {
          if (!open) {
            setPasswordResetLink(null);
          }
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Password reset link</DialogTitle>
            <DialogDescription>
              Send this link to the user. It expires{' '}
              {passwordResetLink
                ? formatRelative(passwordResetLink.expiresAt)
                : 'soon'}
              .
            </DialogDescription>
          </DialogHeader>
          {passwordResetLink ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <span className="min-w-0 font-mono text-xs">
                  {passwordResetLink.url}
                </span>
                <CopyIconButton
                  content={passwordResetLink.url}
                  aria-label="Copy password reset link"
                />
              </div>
              <p className="text-muted-foreground">
                When they open it, they will be prompted to choose a new
                password and sign in again. Existing sessions are revoked after
                they reset the password.
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" onClick={() => setPasswordResetLink(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingRemoval != null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRemoval(null);
          }
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Remove user</DialogTitle>
            <DialogDescription>
              Remove{' '}
              <span className="font-semibold">{pendingRemoval?.name}</span> from
              this deployment? They are signed out immediately and their tasks
              are kept. They can join again later with a new invite or through
              your organization&apos;s sign-in.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingRemoval(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (pendingRemoval) {
                  removeUser.mutate({ userId: pendingRemoval.id });
                }
              }}
              disabled={removeUser.isPending}
            >
              {removeUser.isPending ? 'Removing...' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
