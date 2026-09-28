import { z } from 'zod';
import { isDeploymentExperimentEnabled } from '@roomote/db/server';
import { evaluateTypeSafeJudgments } from '@roomote/cloud-agents/server/typesafe-judgment';

// Jevgrep 0.4.3 asks boolean relevance questions using TypeSafe's native wire
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
    const answers = await evaluateTypeSafeJudgments({
      state: parsed.data.state,
      questions: parsed.data.questions,
      excludeRoomoteModel: true,
      bypassBackendCache: true,
      timeoutMs: 15_000,
    });
    if (!answers) {
      return Response.json({ error: 'Jev is not configured' }, { status: 503 });
    }
    return Response.json({ answers });
  } catch {
    // Upstream errors may contain submitted source or credentials.
    return Response.json(
      { error: 'Jevgrep evaluation failed' },
      { status: 502 },
    );
  }
}
