import { z } from 'zod';
import {
  CREATE_CUSTOM_SKILL_TOOL,
  UPDATE_CUSTOM_SKILL_TOOL,
  customSkillDefinitionSchema,
  createCustomSkillInputSchema,
  isSafeSkillName,
  updateCustomSkillInputSchema,
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

it('defines exact-ID content update and replacement modes', () => {
  const skillId = 'instance:00000000-0000-4000-8000-000000000001';
  expect(Object.keys(UPDATE_CUSTOM_SKILL_TOOL.inputSchema).sort()).toEqual([
    'content',
    'description',
    'expectedVersion',
    'name',
    'skillId',
  ]);
  expect(
    updateCustomSkillInputSchema.parse({
      skillId,
      expectedVersion: 2,
      content: {
        type: 'update_content',
        update_content: {
          content_updates: [{ old_str: 'old', new_str: 'new' }],
        },
      },
    }),
  ).toMatchObject({ skillId, expectedVersion: 2 });
  expect(
    updateCustomSkillInputSchema.parse({
      skillId,
      expectedVersion: 2,
      description: 'Updated use case',
      content: {
        type: 'replace_content',
        replace_content: { new_str: '# Complete instructions' },
      },
    }),
  ).toMatchObject({ content: { type: 'replace_content' } });
});

it('rejects invalid update contract inputs', () => {
  for (const override of [
    { skillId: '00000000-0000-4000-8000-000000000001' },
    { skillId: 'settings:00000000-0000-4000-8000-000000000001' },
    { skillId: 'packaged:review-example' },
    { expectedVersion: 0 },
    {
      content: {
        type: 'update_content',
        update_content: { content_updates: [] },
      },
    },
    {
      content: {
        type: 'update_content',
        update_content: {
          content_updates: [{ old_str: '', new_str: 'new' }],
        },
      },
    },
    { content: { type: 'replace_content', replace_content: {} } },
    { content: 'not an operation' },
  ]) {
    expect(
      updateCustomSkillInputSchema.safeParse({
        skillId: 'instance:00000000-0000-4000-8000-000000000001',
        expectedVersion: 1,
        content: {
          type: 'update_content',
          update_content: {
            content_updates: [{ old_str: 'old', new_str: 'new' }],
          },
        },
        ...override,
      }).success,
    ).toBe(false);
  }
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

it('rejects unexpected fields in the shared schema', () => {
  for (const key of [
    'environmentIds',
    'environmentId',
    'workspaceId',
    'createdByUserId',
    'actorUserId',
    'scope',
  ]) {
    expect(
      createCustomSkillInputSchema.safeParse({ ...skill, [key]: 'injected' })
        .success,
    ).toBe(false);
  }
});

it('rejects empty normalized instructions', () => {
  for (const content of ['', ' ', '\r\n']) {
    expect(
      createCustomSkillInputSchema.safeParse({ ...skill, content }).success,
    ).toBe(false);
  }
});

it('keeps safe legacy filesystem segments separate from new skill names', () => {
  for (const name of ['Legacy_Name', 'legacy.name', '_legacy', 'legacy-1']) {
    expect(isSafeSkillName(name)).toBe(true);
    expect(
      createCustomSkillInputSchema.safeParse({ ...skill, name }).success,
    ).toBe(name === 'legacy-1');
  }
});

it('rejects unsafe legacy filesystem segments', () => {
  for (const name of [
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
  ]) {
    expect(isSafeSkillName(name)).toBe(false);
    expect(
      createCustomSkillInputSchema.safeParse({ ...skill, name }).success,
    ).toBe(false);
  }
});
