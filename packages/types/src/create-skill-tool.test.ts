import { CREATE_SKILL_TOOL, createSkillSchema } from './create-skill-tool';

const input = {
  name: 'review-notes',
  description: ' Review notes ',
  content: ' Read the notes. ',
  environmentIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
};

describe('create_skill schema', () => {
  it('shares manual skill validation and normalization', () => {
    expect(createSkillSchema.parse(input)).toEqual({
      ...input,
      description: 'Review notes',
      content: 'Read the notes.\n',
    });
    expect(CREATE_SKILL_TOOL.inputSchema).toEqual(createSkillSchema.shape);
  });

  it.each([undefined, null, [], ['__all_repositories__'], ['not-a-uuid']])(
    'rejects implicit or invalid environment selection %j',
    (environmentIds) => {
      expect(
        createSkillSchema.safeParse({ ...input, environmentIds }).success,
      ).toBe(false);
    },
  );

  it.each([{ name: 'Invalid Name' }, { description: ' ' }, { content: ' ' }])(
    'rejects invalid manual skill fields %j',
    (fields) => {
      expect(createSkillSchema.safeParse({ ...input, ...fields }).success).toBe(
        false,
      );
    },
  );
});
