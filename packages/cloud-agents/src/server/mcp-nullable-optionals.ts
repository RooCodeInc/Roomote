import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  AnySchema,
  ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodTypeAny } from 'zod';

/**
 * Lets every optional field of a tool input schema accept `null`, at any
 * depth, mapping it back to `undefined` (or the field's default) so handlers
 * keep their existing types and semantics.
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
  if (schema === undefined || schema === null || typeof schema !== 'object') {
    return schema;
  }
  if (schema instanceof z.ZodType) {
    return allowNullDeep(schema) as Schema;
  }
  return Object.fromEntries(
    Object.entries(schema as Record<string, unknown>).map(([key, field]) => [
      key,
      field instanceof z.ZodType ? allowNullDeep(field) : field,
    ]),
  ) as Schema;
}

function keepDescription<T extends ZodTypeAny>(
  schema: T,
  description: string | undefined,
): T {
  return description === undefined
    ? schema
    : (schema.describe(description) as T);
}

function allowNullDeep(schema: ZodTypeAny): ZodTypeAny {
  if (schema instanceof z.ZodOptional) {
    const inner = allowNullDeep(schema.unwrap());
    const nullable =
      inner instanceof z.ZodNullable
        ? inner
        : inner.nullable().transform((value) => value ?? undefined);
    return keepDescription(nullable.optional(), schema.description);
  }
  if (schema instanceof z.ZodDefault) {
    const defaultValue = schema._def.defaultValue;
    const inner = allowNullDeep(schema.removeDefault())
      .nullable()
      .transform((value) => value ?? defaultValue());
    return keepDescription(inner.default(defaultValue), schema.description);
  }
  if (schema instanceof z.ZodNullable) {
    return new z.ZodNullable({
      ...schema._def,
      innerType: allowNullDeep(schema.unwrap()),
    });
  }
  if (schema instanceof z.ZodEffects) {
    return new z.ZodEffects({
      ...schema._def,
      schema: allowNullDeep(schema.innerType()),
    });
  }
  if (schema instanceof z.ZodObject) {
    const shape = withNullableOptionals(schema.shape as z.ZodRawShape);
    return new z.ZodObject({ ...schema._def, shape: () => shape });
  }
  if (schema instanceof z.ZodArray) {
    return new z.ZodArray({
      ...schema._def,
      type: allowNullDeep(schema.element),
    });
  }
  if (schema instanceof z.ZodUnion) {
    const options = (schema.options as ZodTypeAny[]).map(allowNullDeep);
    return new z.ZodUnion({
      ...schema._def,
      options: options as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]],
    });
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = (schema.options as z.AnyZodObject[]).map(
      (option) => allowNullDeep(option) as z.AnyZodObject,
    );
    return keepDescription(
      z.discriminatedUnion(
        schema.discriminator,
        options as [z.AnyZodObject, z.AnyZodObject, ...z.AnyZodObject[]],
      ),
      schema.description,
    );
  }
  return schema;
}

/**
 * An McpServer whose registered tools accept null for optional input fields
 * on the wire (see withNullableOptionals). Handlers still receive undefined.
 * Every Roomote-authored MCP server should be created through this class.
 */
export class NullableOptionalsMcpServer extends McpServer {
  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    cb: ToolCallback<InputArgs>,
  ): RegisteredTool {
    return super.registerTool(
      name,
      { ...config, inputSchema: withNullableOptionals(config.inputSchema) },
      cb,
    );
  }
}
