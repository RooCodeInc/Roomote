'use client';

import { createAuthClient } from 'better-auth/react';
import { genericOAuthClient } from 'better-auth/client/plugins';

type BaseAuthClient = ReturnType<typeof createAuthClient>;
type OAuth2SignInInput = {
  callbackURL?: string;
  providerId: string;
};
type OAuth2SignInResult = Awaited<
  ReturnType<BaseAuthClient['signIn']['social']>
>;
type OAuth2LinkInput = {
  callbackURL: string;
  errorCallbackURL?: string;
  providerId: string;
  scopes?: string[];
};
type OAuth2LinkResult = {
  data?: { redirect: true; url: string } | null;
  error?: { code?: string; message?: string; status?: number } | null;
};
type UnlinkAccountInput = {
  accountId?: string;
  providerId: string;
};
type UnlinkAccountResult = {
  data?: { status: boolean } | null;
  error?: { code?: string; message?: string; status?: number } | null;
};
type ResetPasswordInput = {
  newPassword: string;
  token: string;
};
type ResetPasswordResult = {
  data?: { status: boolean } | null;
  error?: { code?: string; message?: string; status?: number } | null;
};
type ChangePasswordInput = {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
};
type ChangePasswordResult = {
  data?: unknown;
  error?: { code?: string; message?: string; status?: number } | null;
};
type ChangeEmailInput = {
  callbackURL?: string;
  newEmail: string;
};
type ChangeEmailResult = {
  data?: { status: boolean; message?: string | null } | null;
  error?: { code?: string; message?: string; status?: number } | null;
};
type RoomoteAuthClient = BaseAuthClient & {
  signIn: BaseAuthClient['signIn'] & {
    oauth2(input: OAuth2SignInInput): Promise<OAuth2SignInResult>;
  };
  oauth2: {
    link(input: OAuth2LinkInput): Promise<OAuth2LinkResult>;
  };
  unlinkAccount(input: UnlinkAccountInput): Promise<UnlinkAccountResult>;
  resetPassword(input: ResetPasswordInput): Promise<ResetPasswordResult>;
  changePassword(input: ChangePasswordInput): Promise<ChangePasswordResult>;
  changeEmail(input: ChangeEmailInput): Promise<ChangeEmailResult>;
};

export const authClient: RoomoteAuthClient = createAuthClient({
  plugins: [genericOAuthClient()],
}) as RoomoteAuthClient;
