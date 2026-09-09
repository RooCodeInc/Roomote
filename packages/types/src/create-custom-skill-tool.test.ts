import { z } from 'zod';
import {
  CREATE_CUSTOM_SKILL_TOOL,
  customSkillDefinitionSchema,
  createCustomSkillInputSchema,
  isSafeSkillName,
} from './create-custom-skill-tool';

const skill = {
  name: 'review-example',
  description: 'Review examples',
  content: 'Read and review.\n',
};

it('exposes a raw Zod shape for the MCP input schema with only instance definition fields', () => {
  expect(customSkillDefinitionSchema).toBeInstanceOf(z.ZodObject);
  expect(Object.keys(CREATE_CUSTOM_SKILL_TOOL.inputSchema).sort()).toEqual([
    'content',
    'description',
    'name',
  ]);
  expect(z.object(CREATE_CUSTOM_SKILL_TOOL.inputSchema).parse(skill)).toEqual(
    skill,
  );
  expect(
    createCustomSkillInputSchema.parse({
      ...skill,
      name: ` ${skill.name} `,
      description: ` ${skill.description} `,
      content: ' Read and review.\r\n ',
    }),
  ).toEqual(skill);
});

it('bounds names and descriptions and requires every definition field', () => {
  expect(
    createCustomSkillInputSchema.safeParse({
      ...skill,
      name: 'a'.repeat(64),
      description: 'd'.repeat(1024),
    }).success,
  ).toBe(true);
  for (const override of [
    { name: 'a'.repeat(65) },
    { description: 'd'.repeat(1025) },
    { description: '' },
    { name: undefined },
    { description: undefined },
    { content: undefined },
  ]) {
    expect(
      createCustomSkillInputSchema.safeParse({ ...skill, ...override }).success,
    ).toBe(false);
  }
});

it.each([
  'environmentIds',
  'environmentId',
  'workspaceId',
  'createdByUserId',
  'actorUserId',
  'scope',
])('rejects unexpected %s in the shared schema', (key) => {
  expect(
    createCustomSkillInputSchema.safeParse({ ...skill, [key]: 'injected' })
      .success,
  ).toBe(false);
});

it.each(['', ' ', '\r\n'])(
  'rejects empty normalized instructions %j',
  (content) => {
    expect(
      createCustomSkillInputSchema.safeParse({ ...skill, content }).success,
    ).toBe(false);
  },
);

it.each(['Legacy_Name', 'legacy.name', '_legacy', 'legacy-1'])(
  'accepts safe legacy filesystem segment %s without relaxing new skill names',
  (name) => {
    expect(isSafeSkillName(name)).toBe(true);
    expect(
      createCustomSkillInputSchema.safeParse({ ...skill, name }).success,
    ).toBe(name === 'legacy-1');
  },
);

it.each([
  '',
  '.',
  '..',
  '.hidden',
  '../escape',
  'path/name',
  'path\\name',
  '/absolute',
  'with space',
  'line\nbreak',
  'nul\0name',
])('rejects unsafe legacy segment %j', (name) => {
  expect(isSafeSkillName(name)).toBe(false);
  expect(
    createCustomSkillInputSchema.safeParse({ ...skill, name }).success,
  ).toBe(false);
});
