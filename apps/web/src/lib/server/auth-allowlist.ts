export function parseRoomoteAllowedEmails(
  rawAllowedEmails: string | undefined,
): Set<string> {
  return new Set(
    (rawAllowedEmails ?? '')
      .split(/[\s,]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isRoomoteEmailAllowed(
  email: string | null | undefined,
  rawAllowedEmails: string | undefined,
): boolean {
  const allowedEmails = parseRoomoteAllowedEmails(rawAllowedEmails);

  if (allowedEmails.size === 0) {
    return true;
  }

  return !!email && allowedEmails.has(email.trim().toLowerCase());
}
