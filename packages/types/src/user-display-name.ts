import { getIdentityDisplayName } from './identity-display-name';

export type UserDisplayNameInput = {
  name?: string | null;
  email?: string | null;
};

function normalizeNullableString(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function getUserDisplayName(
  user: UserDisplayNameInput | null | undefined,
): string | null {
  if (!user) {
    return null;
  }

  const name = normalizeNullableString(user.name);
  if (name) {
    return name;
  }

  const email = normalizeNullableString(user.email);
  if (email) {
    return getIdentityDisplayName({ emailAddress: email });
  }

  return null;
}
