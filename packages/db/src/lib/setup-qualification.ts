export const SETUP_QUALIFICATION_BLOCK_REASONS = [
  'github_organization_required',
] as const;

export type SetupQualificationBlockReason =
  (typeof SETUP_QUALIFICATION_BLOCK_REASONS)[number];

export const SETUP_QUALIFICATION_BLOCK_STATUSES = [
  'blocked',
  'passed',
  'lifted',
] as const;

export type SetupQualificationBlockStatus =
  (typeof SETUP_QUALIFICATION_BLOCK_STATUSES)[number];
