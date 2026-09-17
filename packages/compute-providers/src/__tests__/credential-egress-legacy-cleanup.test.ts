import { describe, expect, it, vi } from 'vitest';

import { removeLegacyCredentialEgressHostPolicy } from '../credential-egress-legacy-cleanup';

const networkId = 'a'.repeat(64);
const bridge = `br-${networkId.slice(0, 12)}`;
const labels = {
  'dev.roomote.session-egress.policy-image': 'trusted-helper',
  'dev.roomote.session-egress.policy-platform': 'linux/amd64',
};

describe('legacy Session egress host policy cleanup', () => {
  it('leaves ordinary task networks alone', async () => {
    const runDocker = vi.fn(async (_args: string[]) => '');
    await removeLegacyCredentialEgressHostPolicy({ Id: networkId }, runDocker);
    await removeLegacyCredentialEgressHostPolicy(
      { Id: networkId, Labels: { 'dev.roomote.sandbox.managed': 'true' } },
      runDocker,
    );
    expect(runDocker).not.toHaveBeenCalled();
  });

  it('removes only the owned bridge chains of a labelled legacy network', async () => {
    const runDocker = vi.fn(async (_args: string[]) => '');
    await removeLegacyCredentialEgressHostPolicy(
      { Id: networkId, Labels: labels },
      runDocker,
    );
    expect(runDocker).toHaveBeenCalledOnce();
    const args = runDocker.mock.calls[0]![0];
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toContain('trusted-helper');
    expect(args).toContain('linux/amd64');
    const script = args.at(-1)!;
    expect(script).toContain(
      `-D DOCKER-USER -i ${bridge} -j RSE_${networkId.slice(0, 12)}`,
    );
    expect(script).toContain(`iptables -X RSE_${networkId.slice(0, 12)}_I`);
    expect(script).not.toContain('iptables -F DOCKER-USER');
    expect(script).not.toContain('iptables -F INPUT');
    expect(script).not.toContain('iptables -P');
  });

  it('refuses a malformed network identity before touching the host', async () => {
    const runDocker = vi.fn(async (_args: string[]) => '');
    await expect(
      removeLegacyCredentialEgressHostPolicy(
        { Id: 'not-a-network-id', Labels: labels },
        runDocker,
      ),
    ).rejects.toThrow('Invalid Session egress cleanup network identity');
    await expect(
      removeLegacyCredentialEgressHostPolicy(
        {
          Id: networkId,
          Labels: labels,
          Options: { 'com.docker.network.bridge.name': 'br0; iptables -F' },
        },
        runDocker,
      ),
    ).rejects.toThrow('Invalid Session egress cleanup network identity');
    expect(runDocker).not.toHaveBeenCalled();
  });
});
