import { createHash, randomUUID } from 'node:crypto';
import {
  renderManualSkillMarkdown,
  type EnvironmentConfig,
} from '@roomote/types';
import {
  createEnvironmentManualSkill,
  EnvironmentManualSkillValidationError,
  EnvironmentDefinitionConflictError,
  updateEnvironmentDefinition,
  db,
  environmentFactory,
  userFactory,
  environments,
  eq,
} from '../../server';

const skill = {
  name: 'deploy-check',
  description: 'Check deployment',
  content: 'Run the checks.\n',
};

async function createEnvironment(
  overrides: Parameters<typeof environmentFactory.create>[0] = {},
) {
  return environmentFactory.create({
    userId: null,
    createdByUserId: null,
    config: { name: 'Skill test', repositories: [{ repository: 'test/repo' }] },
    ...overrides,
  });
}

async function readEnvironment(id: string) {
  return db.query.environments.findFirst({ where: eq(environments.id, id) });
}

describe('createEnvironmentManualSkill', () => {
  it('normalizes input, keeps the existing skill ID format, and preserves unrelated config', async () => {
    const config = {
      name: 'Skill test',
      repositories: [{ repository: 'test/repo', futureRepositoryOption: true }],
      skills: { 'owner/skills': ['existing'] },
      futureOption: { enabled: true },
      manualSkills: [
        {
          name: 'existing',
          description: 'Existing',
          content: 'Keep me',
          futureSkillOption: true,
        },
      ],
    };
    const environment = await createEnvironment({ config, isVerified: true });
    const result = await createEnvironmentManualSkill({
      ...skill,
      description: ` ${skill.description} `,
      environmentIds: [environment.id, environment.id],
    });
    expect(result).toEqual({
      success: true,
      skillId: `manual@${skill.name}#${createHash('sha256').update(renderManualSkillMarkdown(skill)).digest('hex').slice(0, 12)}`,
      updatedEnvironmentIds: [environment.id],
    });
    const updated = await readEnvironment(environment.id);
    expect(updated?.config).toEqual({
      ...config,
      manualSkills: [skill, ...config.manualSkills],
    });
    expect(updated?.isVerified).toBe(false);
  });

  it.each([
    { environmentIds: [] },
    { environmentIds: ['not-a-uuid'] },
    { environmentIds: undefined },
    { name: '../bad' },
    { description: ' ' },
    { content: ' ' },
  ])('rejects invalid input %j without changing config', async (override) => {
    const environment = await createEnvironment();
    await expect(
      createEnvironmentManualSkill({
        ...skill,
        environmentIds: [environment.id],
        ...override,
      } as Parameters<typeof createEnvironmentManualSkill>[0]),
    ).rejects.toBeInstanceOf(EnvironmentManualSkillValidationError);
    expect((await readEnvironment(environment.id))?.config).toEqual(
      environment.config,
    );
  });

  it.each([
    'missing',
    'private',
    'eval',
    'invalid-config',
    'duplicate',
  ] as const)('atomically rejects a selected %s environment', async (kind) => {
    const first = await createEnvironment();
    const firstId = `00000000${randomUUID().slice(8)}`;
    await db
      .update(environments)
      .set({ id: firstId })
      .where(eq(environments.id, first.id));
    first.id = firstId;
    try {
      const other =
        kind === 'missing'
          ? { id: randomUUID() }
          : await createEnvironment({
              ...(kind === 'private'
                ? { userId: (await userFactory.create()).id }
                : {}),
              ...(kind === 'eval' ? { isEval: true } : {}),
              ...(kind === 'invalid-config'
                ? { config: { name: 'invalid' } as EnvironmentConfig }
                : {}),
              ...(kind === 'duplicate'
                ? { config: { ...first.config, manualSkills: [skill] } }
                : {}),
            });
      await expect(
        createEnvironmentManualSkill({
          ...skill,
          environmentIds: [other.id, first.id],
        }),
      ).rejects.toBeInstanceOf(EnvironmentManualSkillValidationError);
      expect((await readEnvironment(first.id))?.config).toEqual(first.config);
    } finally {
      await db.delete(environments).where(eq(environments.id, first.id));
    }
  });

  it('serializes concurrent distinct skills across overlapping selections in reverse order', async () => {
    const first = await createEnvironment();
    const second = await createEnvironment();
    await Promise.all([
      createEnvironmentManualSkill({
        ...skill,
        environmentIds: [first.id, second.id],
      }),
      createEnvironmentManualSkill({
        ...skill,
        name: 'second',
        environmentIds: [second.id, first.id],
      }),
    ]);
    for (const id of [first.id, second.id]) {
      expect(
        (await readEnvironment(id))?.config.manualSkills?.map(
          (entry) => entry.name,
        ),
      ).toEqual([skill.name, 'second']);
    }
  });

  it('allows exactly one concurrent duplicate without overwriting the winner', async () => {
    const environment = await createEnvironment();
    const results = await Promise.allSettled(
      ['first', 'second'].map((content) =>
        createEnvironmentManualSkill({
          ...skill,
          content,
          environmentIds: [environment.id],
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(
      EnvironmentManualSkillValidationError,
    );
    const skills = (await readEnvironment(environment.id))?.config.manualSkills;
    expect(skills).toHaveLength(1);
    expect(skills?.[0]?.content).toBe(
      results[0]?.status === 'fulfilled' ? 'first\n' : 'second\n',
    );
  });

  it('rejects a stale guarded config writer after creation', async () => {
    const environment = await createEnvironment();
    await createEnvironmentManualSkill({
      ...skill,
      environmentIds: [environment.id],
    });
    await expect(
      updateEnvironmentDefinition(db, {
        environmentId: environment.id,
        expectedConfig: environment.config,
        fields: {
          config: { ...environment.config, description: 'Stale edit' },
        },
      }),
    ).rejects.toBeInstanceOf(EnvironmentDefinitionConflictError);
    expect(
      (await readEnvironment(environment.id))?.config.manualSkills,
    ).toEqual([skill]);
  });
});
