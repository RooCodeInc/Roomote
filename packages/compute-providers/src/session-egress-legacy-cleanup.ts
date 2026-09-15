type DockerCommand = (
  args: string[],
  options?: { signal?: AbortSignal; allowFailure?: boolean },
) => Promise<string>;

/**
 * Task networks created while Docker Session egress used a connector sidecar
 * carry these labels, and the host firewall holds `RSE_<network-id>` chains
 * and jumps for them. The connector path is gone, but a network created
 * before this rollout may still be retained (standby) and cleaned up later,
 * so its rules are removed at teardown by this label-gated helper. Networks
 * without the labels never touch the host firewall.
 *
 * Remove this module once no task network created before the gateway
 * removal can remain (one release after it ships).
 */
const LEGACY_POLICY_IMAGE_LABEL = 'dev.roomote.session-egress.policy-image';
const LEGACY_POLICY_PLATFORM_LABEL =
  'dev.roomote.session-egress.policy-platform';

/** Select one ruleset carrying Docker's hook; stale competing rulesets are ambiguous. */
function selectDockerFirewallBackend(): string[] {
  return [
    'rse_iptables=',
    'rse_ip6tables=',
    'rse_backend=',
    'rse_kind() {',
    '  case "$1" in *"(nf_tables)"*) printf nft;; *"(legacy)"*) printf legacy;; *) return 1;; esac',
    '}',
    'for rse_suffix in -nft -legacy ""; do',
    '  rse_v4="iptables${rse_suffix}"',
    '  command -v "$rse_v4" >/dev/null 2>&1 || continue',
    '  "$rse_v4" -S DOCKER-USER >/dev/null 2>&1 || continue',
    '  "$rse_v4" -C FORWARD -j DOCKER-USER >/dev/null 2>&1 || continue',
    '  rse_current=$(rse_kind "$("$rse_v4" --version)") || { echo "Unrecognized Docker firewall backend" >&2; exit 1; }',
    '  if [ -n "$rse_backend" ] && [ "$rse_backend" != "$rse_current" ]; then echo "Ambiguous Docker firewall backends" >&2; exit 1; fi',
    '  if [ -z "$rse_backend" ]; then rse_backend="$rse_current"; rse_iptables="$rse_v4"; fi',
    'done',
    'test -n "$rse_iptables" || { echo "Docker firewall backend unavailable" >&2; exit 1; }',
    'for rse_suffix in -nft -legacy ""; do',
    '  rse_v6="ip6tables${rse_suffix}"',
    '  command -v "$rse_v6" >/dev/null 2>&1 || continue',
    '  rse_current=$(rse_kind "$("$rse_v6" --version)") || continue',
    '  [ "$rse_current" = "$rse_backend" ] || continue',
    '  "$rse_v6" -S OUTPUT >/dev/null 2>&1 || continue',
    '  rse_ip6tables="$rse_v6"; break',
    'done',
    'test -n "$rse_ip6tables" || { echo "Matching IPv6 firewall backend unavailable" >&2; exit 1; }',
    'iptables() { command "$rse_iptables" "$@"; }',
    'ip6tables() { command "$rse_ip6tables" "$@"; }',
  ];
}

/** Called only after task endpoints have been stopped/disconnected. */
export async function removeLegacySessionEgressHostPolicy(
  network: {
    Id?: string;
    Options?: Record<string, string>;
    Labels?: Record<string, string> | null;
  },
  runDocker: DockerCommand,
): Promise<void> {
  const image = network.Labels?.[LEGACY_POLICY_IMAGE_LABEL];
  const platform = network.Labels?.[LEGACY_POLICY_PLATFORM_LABEL];
  if (!image || !platform) return;
  const id = network.Id ?? '';
  const bridge =
    network.Options?.['com.docker.network.bridge.name'] ||
    `br-${id.slice(0, 12)}`;
  if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-zA-Z0-9_-]{1,15}$/.test(bridge)) {
    throw new Error('Invalid Session egress cleanup network identity');
  }
  const chain = `RSE_${id.slice(0, 12)}`;
  const inputChain = `${chain}_I`;
  const guard = `${chain}_G`;
  const script = [
    'set -eu',
    ...selectDockerFirewallBackend(),
    'iptables -S DOCKER-USER >/dev/null',
    `while iptables -C DOCKER-USER -i ${bridge} -j ${chain} 2>/dev/null; do iptables -D DOCKER-USER -i ${bridge} -j ${chain}; done`,
    `while iptables -C DOCKER-USER -i ${bridge} -j DROP 2>/dev/null; do iptables -D DOCKER-USER -i ${bridge} -j DROP; done`,
    `while iptables -C DOCKER-USER -i ${bridge} -j ${guard} 2>/dev/null; do iptables -D DOCKER-USER -i ${bridge} -j ${guard}; done`,
    `if iptables -S ${guard} >/dev/null 2>&1; then iptables -F ${guard}; iptables -X ${guard}; fi`,
    `iptables -C INPUT -i ${bridge} -j ${inputChain} 2>/dev/null && iptables -D INPUT -i ${bridge} -j ${inputChain} || true`,
    `ip6tables -C INPUT -i ${bridge} -j ${inputChain} 2>/dev/null && ip6tables -D INPUT -i ${bridge} -j ${inputChain} || true`,
    `ip6tables -C FORWARD -i ${bridge} -j ${inputChain} 2>/dev/null && ip6tables -D FORWARD -i ${bridge} -j ${inputChain} || true`,
    `if iptables -S ${inputChain} >/dev/null 2>&1; then iptables -F ${inputChain}; iptables -X ${inputChain}; fi`,
    `if ip6tables -S ${inputChain} >/dev/null 2>&1; then ip6tables -F ${inputChain}; ip6tables -X ${inputChain}; fi`,
    `if iptables -S ${chain} >/dev/null 2>&1; then iptables -F ${chain}; iptables -X ${chain}; fi`,
  ].join('\n');
  await runDocker([
    'run',
    '--rm',
    '--network',
    'host',
    '--user',
    'root',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_ADMIN',
    '--cap-add',
    'NET_RAW',
    '--platform',
    platform,
    '--entrypoint',
    '/bin/sh',
    image,
    '-c',
    script,
  ]);
}
