import { z } from 'zod';

import {
  automationWorkItemInputSchema,
  buildAutomationWorkItem,
} from '../automation-work-items-tool.js';

const inputSchema = z.object(automationWorkItemInputSchema);

const validToolParams = {
  title: 'Fix GHCR unauthorized in deployment acceptance',
  brief:
    'Publish GHCR Images on develop fails deployment acceptance with an unauthorized image pull.',
  category: 'chore',
  priority: 'P1',
  actionKind: 'code_change_pr',
  executionPrompt:
    'Reproduce the unauthorized GHCR pull, add a docker login step, and open a PR.',
  fingerprint: 'RooCodeInc/Roomote publish-ghcr deployment-acceptance',
  targetRepositoryFullName: 'RooCodeInc/Roomote',
  targetEnvironmentId: '10b031ec-b728-4d8f-a9a0-1ed4aa500511',
};

describe('automationWorkItemInputSchema', () => {
  it('accepts a valid flat work item', () => {
    const result = inputSchema.safeParse(validToolParams);

    expect(result.success).toBe(true);
  });

  it('uses only flat scalar fields, with no nested arrays or objects', () => {
    for (const [fieldName, fieldSchema] of Object.entries(
      automationWorkItemInputSchema,
    )) {
      let schema: z.ZodTypeAny = fieldSchema;

      while (
        schema instanceof z.ZodOptional ||
        schema instanceof z.ZodEffects
      ) {
        schema =
          schema instanceof z.ZodOptional
            ? schema.unwrap()
            : schema.innerType();
      }

      expect(
        schema instanceof z.ZodString || schema instanceof z.ZodEnum,
        `${fieldName} should be a flat string or enum`,
      ).toBe(true);
    }
  });

  it('marks the fields the platform requires for act items as required', () => {
    for (const requiredField of [
      'title',
      'brief',
      'actionKind',
      'executionPrompt',
      'targetRepositoryFullName',
      'targetEnvironmentId',
    ] as const) {
      const { [requiredField]: _omitted, ...withoutField } = validToolParams;
      const result = inputSchema.safeParse(withoutField);

      expect(result.success, `${requiredField} should be required`).toBe(false);

      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual([requiredField]);
      }
    }
  });

  it('accepts the disposition act compatibility value and rejects suggest', () => {
    expect(
      inputSchema.safeParse({ ...validToolParams, disposition: 'act' }).success,
    ).toBe(true);

    const suggestResult = inputSchema.safeParse({
      ...validToolParams,
      disposition: 'suggest',
    });

    expect(suggestResult.success).toBe(false);
  });

  it('rejects a non-uuid targetEnvironmentId', () => {
    const result = inputSchema.safeParse({
      ...validToolParams,
      targetEnvironmentId: 'not-a-uuid',
    });

    expect(result.success).toBe(false);
  });
});

describe('buildAutomationWorkItem', () => {
  it('maps tool params to a single act work item for the platform API', () => {
    const parsed = inputSchema.parse(validToolParams);
    const workItem = buildAutomationWorkItem(parsed);

    expect(workItem).toEqual({
      title: validToolParams.title,
      brief: validToolParams.brief,
      category: 'chore',
      priority: 'P1',
      actionKind: 'code_change_pr',
      disposition: 'act',
      investigationContext: undefined,
      executionPrompt: validToolParams.executionPrompt,
      fingerprint: validToolParams.fingerprint,
      targetRepositoryFullName: validToolParams.targetRepositoryFullName,
      targetEnvironmentId: validToolParams.targetEnvironmentId,
    });
  });
});
