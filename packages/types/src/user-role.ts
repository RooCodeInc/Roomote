/**
 * Deployment-level user role.
 *
 * - `admin`: full control of the deployment, including deployment settings
 *   and user management. The deployment's first user is always an admin, and
 *   users that existed before roles were introduced were backfilled as
 *   admins.
 * - `member`: can use the product but cannot manage deployment settings or
 *   other users.
 */
export type UserRole = 'admin' | 'member';

export const USER_ROLES = ['admin', 'member'] as const;
