/**
 * Deployment-level sign-in access policy.
 *
 * Sign-in access is the deployment's membership boundary; signed-in users
 * hold an admin or member role (see UserRole). Access is granted by any of:
 *
 * - membership in the deployment's provider organization: the anchored Slack
 *   workspace or the configured Microsoft tenant,
 * - an invite link (invites table; possession of the token authorizes
 *   sign-up through any method, including email/password),
 * - being the deployment's first admin, authorized by SETUP_TOKEN acting as
 *   a system invite.
 *
 * This policy record only stores the Slack workspace anchor, captured from
 * the first signed-in Slack user's ID token. The R_ALLOWED_EMAILS env
 * var remains an additional operator-owned restriction on top.
 */

export type DeploymentAccessPolicy = {
  /**
   * Slack workspace team id anchoring workspace membership. Null when Slack
   * is not the sign-in provider or no anchor has been captured yet.
   */
  slackTeamId: string | null;
};

export function normalizeDeploymentAccessPolicy(
  value: unknown,
): DeploymentAccessPolicy | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<DeploymentAccessPolicy>;

  return {
    slackTeamId:
      typeof candidate.slackTeamId === 'string' && candidate.slackTeamId.trim()
        ? candidate.slackTeamId.trim()
        : null,
  };
}
