import { PersonalSettingsPage } from '@/components/settings/pages/PersonalSettingsPage';
import { userHasCredentialAccount } from '@/lib/server';
import { authorizeOrThrow } from '@/lib/server/auth-context';

export default async function Page() {
  const authorizedUser = await authorizeOrThrow();
  const canChangePassword = await userHasCredentialAccount(
    authorizedUser.userId,
  );

  return (
    <PersonalSettingsPage
      canChangePassword={canChangePassword}
      profile={{
        email: authorizedUser.primaryEmail ?? '',
        imageUrl: authorizedUser.resource.imageUrl,
        name: authorizedUser.name ?? authorizedUser.primaryEmail ?? 'User',
      }}
    />
  );
}
