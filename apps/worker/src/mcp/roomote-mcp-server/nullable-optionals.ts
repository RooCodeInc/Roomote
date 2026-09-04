import { z } from 'zod';

/**
 * Lets every optional field of a tool input shape accept `null`, mapping it
 * back to `undefined` so handlers keep their existing types and semantics.
 *
 * Models trained on strict structured outputs (OpenAI's gpt-5.x family)
 * emit every property of a tool schema on every call. When a property they
 * do not need cannot be null, they invent a type-valid value instead:
 * `""`, `0`, `"unused"`, `false`. That filler then fails validation or,
 * worse, changes what the tool does (a filler threadId once routed a
 * comment edit to the wrong GitHub endpoint). Measured directly against
 * gpt-5.6 with the manage_source_control schema: 20-22 filler values per
 * call as shipped, 1 with nullable optionals, with the rest sent as null.
 *
 * Refinements on the inner schema still apply to non-null values, so a
 * literal `0` for a positive number is rejected exactly as before.
 */
export function withNullableOptionals<Schema>(schema: Schema): Schema {
  if (
    schema === undefined ||
    schema === null ||
    typeof schema !== 'object' ||
    schema instanceof z.ZodType
  ) {
    return schema;
  }

  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>).map(([key, field]) => [
      key,
      allowNullForOptional(field),
    ]),
  ) as Schema;
}

function allowNullForOptional(field: unknown): unknown {
  if (!(field instanceof z.ZodOptional)) {
    return field;
  }
  const inner: z.ZodTypeAny = field.unwrap();
  if (inner instanceof z.ZodNullable) {
    return field;
  }
  const wrapped = inner
    .nullable()
    .transform((value) => value ?? undefined)
    .optional();
  return field.description === undefined
    ? wrapped
    : wrapped.describe(field.description);
}
