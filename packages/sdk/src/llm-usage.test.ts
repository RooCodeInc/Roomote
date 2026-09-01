import type { RecordLlmUsageInput } from './llm-usage';

test('requires SDK callers to identify their usage source', () => {
  expectTypeOf<RecordLlmUsageInput>().toMatchTypeOf<{ source: string }>();
  expectTypeOf<{ eventKey: string }>().not.toMatchTypeOf<RecordLlmUsageInput>();
});
