const experiment = vi.hoisted(() => vi.fn());
vi.mock('@roomote/db/server', () => ({
  isDeploymentExperimentEnabled: experiment,
}));
const evaluate = vi.hoisted(() => vi.fn());
vi.mock('@roomote/cloud-agents/server/typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: evaluate,
}));
import { evaluateJevgrepRequest } from '../jevgrep';

const request = {
  model: 'caller-selected-model',
  state: { source: 'example' },
  questions: { relevant: { type: 'noul', instructions: 'Is this relevant?' } },
};
beforeEach(() => {
  vi.resetAllMocks();
  experiment.mockResolvedValue(true);
});

it('uses the configured Jev model and preserves probabilities in the CLI wire format', async () => {
  const answers = { relevant: { type: 'noul', noul: 0.83 } };
  evaluate.mockResolvedValue(answers);
  const response = await evaluateJevgrepRequest(request);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ answers });
  expect(evaluate).toHaveBeenCalledWith({
    state: request.state,
    questions: request.questions,
    excludeRoomoteModel: true,
    bypassBackendCache: true,
    skipShadow: true,
    timeoutMs: 15_000,
  });
});

it('returns unavailable when the selected Jev backend is absent or disabled', async () => {
  evaluate.mockResolvedValue(null);
  expect((await evaluateJevgrepRequest(request)).status).toBe(503);
});

it('does not return source or credentials in upstream errors', async () => {
  evaluate.mockRejectedValue(new Error('private-source private-key'));
  const response = await evaluateJevgrepRequest(request);
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'Jevgrep evaluation failed' });
});

it.each([
  null,
  {},
  { ...request, questions: {} },
  { ...request, questions: { x: { type: 'choice', instructions: 'Pick' } } },
])('rejects invalid evaluation requests', async (body) => {
  expect((await evaluateJevgrepRequest(body)).status).toBe(400);
  expect(evaluate).not.toHaveBeenCalled();
});

it('stops evaluations when the experiment is turned off', async () => {
  experiment.mockResolvedValue(false);
  expect((await evaluateJevgrepRequest(request)).status).toBe(403);
  expect(evaluate).not.toHaveBeenCalled();
});
