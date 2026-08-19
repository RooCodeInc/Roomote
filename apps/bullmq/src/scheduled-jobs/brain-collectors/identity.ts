import { createHash } from 'node:crypto';

export type PersonIdentityProvider = {
  provider: string;
  identifier: string;
  display?: string | null;
  title?: string | null;
  updatedAt: Date;
};

export type PersonIdentityRecord = {
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  providers: PersonIdentityProvider[];
};

export type PersonIdentityReference = {
  slug: string;
  title: string;
  effectiveDate?: Date;
};

export const LEGACY_SETUP_BOOTSTRAP_USER_ID = 'setup-bootstrap-user';

export function personIdentitySlug(userId: string): string {
  const digest = createHash('sha256').update(userId).digest('hex').slice(0, 16);
  return `people/roomote-member-${digest}`;
}

export function normalizeIdentityAlias(value: string): string {
  return singleLineIdentityValue(value).toLocaleLowerCase();
}

export function singleLineIdentityValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const IDENTITY_EMAIL_PATTERN =
  /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;

export function brainSafeIdentityValue(value: string): string {
  return singleLineIdentityValue(value)
    .replace(IDENTITY_EMAIL_PATTERN, '')
    .replace(/<\s*>|\(\s*\)|\[\s*\]|\{\s*\}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:|/\\<>(){}\-–—]+|[\s,;:|/\\<>(){}\-–—]+$/g, '')
    .trim();
}

export function personIdentityDisplayName(
  record: PersonIdentityRecord,
): string {
  return brainSafeIdentityValue(record.name) || 'Roomote member';
}

export function personIdentityAliases(record: PersonIdentityRecord): string[] {
  const aliases = new Map<string, string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value ? brainSafeIdentityValue(value) : '';
    if (trimmed) {
      aliases.set(normalizeIdentityAlias(trimmed), trimmed);
    }
  };

  add(record.name);
  for (const provider of record.providers) {
    add(provider.identifier);
    add(provider.display);
  }

  return [...aliases.values()].sort((a, b) => a.localeCompare(b));
}
