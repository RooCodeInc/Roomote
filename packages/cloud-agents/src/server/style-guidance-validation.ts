import { z } from 'zod';

import {
  generateTrackedNonTaskObject,
  NON_TASK_INFERENCE_SURFACES,
} from './non-task-provider-usage';

const styleGuidanceValidationSchema = z.object({
  isToneOnly: z.boolean(),
  confidence: z.number().nullable().optional(),
});

const STYLE_GUIDANCE_VALIDATION_SYSTEM_PROMPT = `
You validate organization-level tone-of-voice guidance for a software engineering agent.

Approve only input that is purely about communication style or tone of voice.

Approve examples like:
- concise
- warm and approachable
- direct and blunt
- formal and reserved
- playful but still professional
- empathetic when explaining blockers
- high-energy and enthusiastic

Reject any instruction about:
- coding behavior
- tools, MCPs, or integrations
- planning or execution workflow
- testing, validation, or delivery requirements
- formatting rules, markdown structure, or section layout
- escalation, approvals, or review policy
- product policy, safety policy, or permissions

Reject mixed input if any part goes beyond tone of voice.
Return only the structured result.
`.trim();

export async function validateStyleGuidance(input: {
  styleGuidance: string;
  userId?: string | null;
}): Promise<{
  isToneOnly: boolean;
  confidence: number | null;
}> {
  const { object } = await generateTrackedNonTaskObject({
    userId: input.userId,
    surface: NON_TASK_INFERENCE_SURFACES.vibesStyleValidation,
    maxOutputTokens: 256,
    schema: styleGuidanceValidationSchema,
    system: STYLE_GUIDANCE_VALIDATION_SYSTEM_PROMPT,
    prompt: input.styleGuidance,
  });

  const confidence =
    typeof object.confidence === 'number' && Number.isFinite(object.confidence)
      ? object.confidence
      : null;

  return {
    isToneOnly: object.isToneOnly,
    confidence,
  };
}
