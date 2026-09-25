import { z } from 'zod';

import { GET_PARTNERSHIP_GUIDE_TOOL } from './partnership-guide-tool';

it('defines an argument-less read-only partnership guide tool', () => {
  expect(GET_PARTNERSHIP_GUIDE_TOOL.name).toBe('get_partnership_guide');
  expect(GET_PARTNERSHIP_GUIDE_TOOL.title).toBe('Get Partnership Guide');
  expect(GET_PARTNERSHIP_GUIDE_TOOL.description).toContain(
    'joint investigations, design or prompt reviews, and sustained discussions',
  );
  expect(GET_PARTNERSHIP_GUIDE_TOOL.description).toContain(
    'not for routine task dispatch or self-contained local work',
  );
  expect(GET_PARTNERSHIP_GUIDE_TOOL.description).toContain(
    'grants no authorization',
  );
  expect(GET_PARTNERSHIP_GUIDE_TOOL.inputSchema).toEqual({});
  expect(
    z.object(GET_PARTNERSHIP_GUIDE_TOOL.inputSchema).strict().parse({}),
  ).toEqual({});
  expect(GET_PARTNERSHIP_GUIDE_TOOL.annotations).toMatchObject({
    readOnlyHint: true,
    idempotentHint: true,
  });
});
