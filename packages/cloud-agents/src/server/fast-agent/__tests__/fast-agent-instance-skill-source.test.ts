import { getCustomSkill, listCustomSkills } from '@roomote/db/server';
import { RemoteFastAgentInstanceSkillSource } from '../fast-agent-instance-skill-source';

vi.mock('@roomote/db/server', () => ({
  getCustomSkill: vi.fn(),
  listCustomSkills: vi.fn(),
}));

const skillId = '00000000-0000-4000-8000-000000000001';

beforeEach(() => vi.clearAllMocks());

it('exposes the current instance version on list and load', async () => {
  const skill = {
    id: skillId,
    name: 'review-checklist',
    description: 'Review changes',
    content: 'Check the diff.\n',
    version: 3,
  };
  vi.mocked(listCustomSkills).mockResolvedValue([skill] as never);
  vi.mocked(getCustomSkill).mockResolvedValue(skill as never);
  const source = new RemoteFastAgentInstanceSkillSource('actor');
  await expect(source.list()).resolves.toMatchObject({
    skills: [
      expect.objectContaining({ id: `instance:${skillId}`, version: 3 }),
    ],
  });
  await expect(source.read(`instance:${skillId}`)).resolves.toMatchObject({
    id: `instance:${skillId}`,
    version: 3,
    content: expect.stringContaining('Check the diff.'),
  });
});

it.each([
  '../SKILL.md',
  '/SKILL.md',
  'resources/guide.md',
  'SKILL.md/..',
  'skill.md',
  '',
])(
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
