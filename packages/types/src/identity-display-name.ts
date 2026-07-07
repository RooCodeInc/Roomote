export type IdentityDisplayNameInput = {
  firstName?: string | null;
  lastName?: string | null;
  emailAddress?: string | null;
  identifier?: string | null;
  username?: string | null;
};

function getEmailLocalPart(email: string): string {
  const trimmedEmail = email.trim();
  const atIndex = trimmedEmail.indexOf('@');

  if (atIndex <= 0) {
    return trimmedEmail;
  }

  return trimmedEmail.slice(0, atIndex);
}

export function getIdentityDisplayName({
  firstName,
  lastName,
  emailAddress,
  identifier,
  username,
}: IdentityDisplayNameInput): string {
  const fullName = `${firstName ?? ''} ${lastName ?? ''}`.trim();

  if (fullName.length > 0) {
    return fullName;
  }

  if (username && username.trim().length > 0) {
    return username.trim();
  }

  const emailFallback = emailAddress ?? identifier;

  if (emailFallback && emailFallback.trim().length > 0) {
    return getEmailLocalPart(emailFallback);
  }

  return 'Unknown';
}
