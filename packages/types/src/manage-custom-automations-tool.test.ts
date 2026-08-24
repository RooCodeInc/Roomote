import { describe, expect, it } from 'vitest';

import {
  MANAGE_CUSTOM_AUTOMATIONS_ACTIONS,
  MANAGE_CUSTOM_AUTOMATIONS_TOOL,
  manageCustomAutomationsInputSchema,
} from './manage-custom-automations-tool';

describe('manage custom automations tool contract', () => {
  it('keeps every supported action in the shared Zod schema', () => {
    for (const action of MANAGE_CUSTOM_AUTOMATIONS_ACTIONS) {
      expect(manageCustomAutomationsInputSchema.parse({ action })).toEqual({
        action,
      });
    }
  });

  it('publishes the canonical descriptor and field descriptions', () => {
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.name).toBe(
      'manage_custom_automations',
    );
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.description).toContain(
      'Admin-only management of deployment custom automations.',
    );
    expect(MANAGE_CUSTOM_AUTOMATIONS_TOOL.description).toContain(
      'run the automation in Fast mode',
    );
    expect(
      MANAGE_CUSTOM_AUTOMATIONS_TOOL.inputSchema.environmentId.description,
    ).toContain('Fast mode without an initial sandbox task');
    expect(
      MANAGE_CUSTOM_AUTOMATIONS_TOOL.inputSchema.schedule.description,
    ).toContain('off, every_hour, every_6_hours, daily, weekly');
    expect(
      MANAGE_CUSTOM_AUTOMATIONS_TOOL.inputSchema.prompt.description,
    ).toContain('Do not mention internal tool names or parameters.');
  });
});
