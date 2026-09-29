import { z } from 'zod';
import { isDeploymentExperimentEnabled } from '@roomote/db/server';
import { evaluateTypeSafeJudgmentsWithUsage } from '@roomote/cloud-agents/server/typesafe-judgment';

// Jevgrep 0.5.0 asks boolean relevance questions using TypeSafe's native wire
// format. The server selects the configured Jev backend and model; callers
// cannot select an upstream, supply credentials, or enable the Roomote model.
const requestSchema = z.object({
  state: z.unknown(),
  questions: z
    .record(
      z.object({
        type: z.literal('noul'),
        instructions: z.string().min(1).max(32_768),
      }),
    )
    .refine((questions) => {
      const count = Object.keys(questions).length;
      return count > 0 && count <= 512;
    }),
});

export async function evaluateJevgrepRequest(body: unknown): Promise<Response> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'Invalid Jevgrep evaluation request' },
      { status: 400 },
    );
  }
  try {
    if (!(await isDeploymentExperimentEnabled('jevgrep'))) {
      return Response.json(
        { error: 'Jevgrep experiment is disabled' },
        { status: 403 },
      );
    }
    const result = await evaluateTypeSafeJudgmentsWithUsage({
      state: parsed.data.state,
      questions: parsed.data.questions,
      excludeRoomoteModel: true,
      bypassBackendCache: true,
      skipShadow: true,
      timeoutMs: 15_000,
    });
    if (!result) {
      return Response.json({ error: 'Jev is not configured' }, { status: 503 });
    }
    // Jevgrep reconciles its conservative token reservations with these counts.
    // Dropping usage keeps its local rate limiter artificially throttled.
    return Response.json({
      answers: result.answers,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        total_tokens: result.usage.totalTokens,
      },
    });
  } catch {
    // Upstream errors may contain submitted source or credentials.
    return Response.json(
      { error: 'Jevgrep evaluation failed' },
      { status: 502 },
    );
  }
}
