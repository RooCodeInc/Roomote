import { getCustomSkill, listCustomSkills } from '@roomote/db/server';
import { RemoteFastAgentInstanceSkillSource } from '../fast-agent-instance-skill-source';

vi.mock('@roomote/db/server', () => ({
  getCustomSkill: vi.fn(),
  listCustomSkills: vi.fn(),
}));

const skillId = '00000000-0000-4000-8000-000000000001';

beforeEach(() => vi.clearAllMocks());

it.each(['../SKILL.md', '/SKILL.md', 'SKILL.md/..', ''])(
  'rejects unsupported resource %s without querying content',
  async (resource) => {
    const source = new RemoteFastAgentInstanceSkillSource('actor');
    await expect(source.read(`instance:${skillId}`, resource)).rejects.toThrow(
      'Unknown instance skill or resource',
    );
    expect(getCustomSkill).not.toHaveBeenCalled();
  },
);

it.each([
  'instance:../secret',
  'instance:',
  `settings:${skillId}`,
  `instance:${skillId}/SKILL.md`,
  'instance:foreign:skill',
])('rejects malformed or foreign IDs: %s', async (id) => {
  await expect(
    new RemoteFastAgentInstanceSkillSource('actor').read(id),
  ).rejects.toThrow();
  expect(getCustomSkill).not.toHaveBeenCalled();
});

it('propagates authorization and database failures instead of falling back', async () => {
  const error = new Error('Active member access required');
  vi.mocked(listCustomSkills).mockRejectedValue(error);
  vi.mocked(getCustomSkill).mockRejectedValue(error);
  const source = new RemoteFastAgentInstanceSkillSource('actor');
  await expect(
    source.list({ environmentId: 'agent-supplied-scope' }),
  ).rejects.toBe(error);
  await expect(source.read(`instance:${skillId}`)).rejects.toBe(error);
  expect(listCustomSkills).toHaveBeenCalledWith('actor');
  expect(getCustomSkill).toHaveBeenCalledWith('actor', skillId);
});

it('loads stored Markdown resources by exact path', async () => {
  vi.mocked(getCustomSkill).mockResolvedValue({
    id: skillId,
    name: 'shared-skill',
    description: 'Use this shared skill.',
    content: '# Instructions\n',
    document:
      '---\nname: shared-skill\ndescription: Use this shared skill.\nallowed-tools: Read\n---\n\n# Exact marketplace instructions',
    resources: [
      {
        path: 'resources/guide.md',
        contentBase64: Buffer.from('# Guide').toString('base64'),
        executable: false,
      },
      {
        path: 'scripts/check.sh',
        contentBase64: Buffer.from('echo ok').toString('base64'),
        executable: true,
      },
    ],
    createdByUserId: 'actor',
    createdAt: new Date(),
    updatedAt: new Date(),
    marketplaceSource: 'owner/catalog',
    marketplaceRevision: 'revision',
    canManage: true,
  });

  const document = await new RemoteFastAgentInstanceSkillSource('actor').read(
    `instance:${skillId}`,
    'resources/guide.md',
  );

  expect(document.content).toBe('# Guide');
  expect(document.resources).toEqual(['SKILL.md', 'resources/guide.md']);
  await expect(
    new RemoteFastAgentInstanceSkillSource('actor').read(`instance:${skillId}`),
  ).resolves.toMatchObject({
    content: expect.stringContaining('allowed-tools: Read'),
  });
});
