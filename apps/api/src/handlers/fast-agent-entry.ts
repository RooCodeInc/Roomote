type FastAgentEntryMode = 'explicit' | 'default';

export function resolveFastAgentEntryMode(params: {
  explicitInvocation: boolean;
  userDefaultEnabled: boolean;
}): FastAgentEntryMode | null {
  if (params.explicitInvocation) {
    return 'explicit';
  }

  return params.userDefaultEnabled ? 'default' : null;
}
