import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpConnectionSnowflakeConfig } from '@roomote/types';
import { z } from 'zod';

import { toMcpToolResult, type McpAuthContext } from '../proxy-utils';

import {
  executeQuery,
  resolveSnowflakeConnectionConfig,
  type SnowflakeQueryRow,
  withSnowflakeConnection,
} from './connection';

const TOOL_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const nonEmptyStringSchema = z.string().refine((value) => value.length > 0, {
  message: 'Value must be non-empty.',
});

const LEADING_SQL_COMMENTS_PATTERN =
  /^\s*(?:(?:--[^\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/))*\s*/;
const TOP_LEVEL_STATEMENT_KEYWORDS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'CALL',
  'SHOW',
  'DESCRIBE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'COPY',
  'GRANT',
  'REVOKE',
  'USE',
]);

function getRowValue(row: SnowflakeQueryRow, column: string): unknown {
  const target = column.toLowerCase();

  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }

  return undefined;
}

function parseIdentifier(
  input: string,
  expectedSegments: number,
  fieldName: string,
): string[] {
  const segments: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (character === '"') {
      if (inQuotes && input[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (character === '.' && !inQuotes) {
      const segment = current.trim();
      if (!segment) {
        throw new Error(
          `${fieldName} must contain ${expectedSegments} identifier segments`,
        );
      }

      segments.push(segment);
      current = '';
      continue;
    }

    current += character;
  }

  if (inQuotes) {
    throw new Error(`${fieldName} contains an unterminated quoted identifier`);
  }

  const finalSegment = current.trim();
  if (!finalSegment) {
    throw new Error(
      `${fieldName} must contain ${expectedSegments} identifier segments`,
    );
  }

  segments.push(finalSegment);

  if (segments.length !== expectedSegments) {
    throw new Error(
      `${fieldName} must contain ${expectedSegments} identifier segments`,
    );
  }

  return segments;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteQualifiedName(...identifiers: string[]): string {
  return identifiers.map(quoteIdentifier).join('.');
}

function detectStatementType(sql: string): string | null {
  const cleaned = sql.replace(LEADING_SQL_COMMENTS_PATTERN, '').trimStart();
  const firstKeyword = cleaned.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();

  if (!firstKeyword) {
    return null;
  }

  if (firstKeyword !== 'WITH') {
    return firstKeyword;
  }

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index] ?? '';
    const nextCharacter = cleaned[index + 1];

    if (inLineComment) {
      if (character === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (character === '*' && nextCharacter === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inSingleQuote) {
      if (character === "'" && nextCharacter === "'") {
        index += 1;
        continue;
      }

      if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (character === '"' && nextCharacter === '"') {
        index += 1;
        continue;
      }

      if (character === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (character === '-' && nextCharacter === '-') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (character === '/' && nextCharacter === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (character === "'") {
      inSingleQuote = true;
      continue;
    }

    if (character === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (character === '(') {
      depth += 1;
      continue;
    }

    if (character === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (
      depth === 0 &&
      /[A-Za-z]/.test(character) &&
      (index === 0 || !/[A-Za-z]/.test(cleaned[index - 1] ?? ''))
    ) {
      const keyword = cleaned
        .slice(index)
        .match(/^([A-Za-z]+)/)?.[1]
        ?.toUpperCase();

      if (keyword && TOP_LEVEL_STATEMENT_KEYWORDS.has(keyword)) {
        return keyword;
      }
    }
  }

  return firstKeyword;
}

function assertStatementAllowed(
  sql: string,
  config: McpConnectionSnowflakeConfig,
): void {
  const statementType = detectStatementType(sql);
  const allowedStatementTypes = config.allowedStatementTypes?.map((type) =>
    type.toUpperCase(),
  );

  // TODO: Move this allowlist source to the admin-managed Snowflake
  // integration settings once that configuration surface exists.
  if (!allowedStatementTypes?.length) {
    return;
  }

  if (!statementType || !allowedStatementTypes.includes(statementType)) {
    const allowedList = allowedStatementTypes.join(', ');
    throw new Error(
      `Snowflake statement type ${statementType ?? 'UNKNOWN'} is not allowed. Allowed statement types: ${allowedList}`,
    );
  }
}

export function registerSnowflakeTools(
  server: McpServer,
  auth: McpAuthContext,
  config: McpConnectionSnowflakeConfig,
) {
  const connectionConfig = resolveSnowflakeConnectionConfig(config);

  server.registerTool(
    'execute_sql',
    {
      title: 'Execute SQL',
      description:
        'Execute a Snowflake SQL statement and return the result rows as JSON.',
      inputSchema: {
        sql: nonEmptyStringSchema.describe(
          'The non-empty SQL statement to execute.',
        ),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: {
        ...TOOL_ANNOTATIONS,
        readOnlyHint: false,
      },
    },
    async ({ sql }) => {
      assertStatementAllowed(sql, config);

      const rows = await withSnowflakeConnection(
        connectionConfig,
        (connection) => executeQuery(connection, sql),
      );

      return toMcpToolResult({
        rowCount: rows.length,
        rows,
      });
    },
  );

  server.registerTool(
    'list_databases',
    {
      title: 'List Databases',
      description: 'List Snowflake databases visible to the configured role.',
      inputSchema: {},
      outputSchema: z.object({}).passthrough(),
      annotations: {
        ...TOOL_ANNOTATIONS,
        readOnlyHint: true,
      },
    },
    async () => {
      const rows = await withSnowflakeConnection(
        connectionConfig,
        (connection) => executeQuery(connection, 'SHOW DATABASES'),
      );

      return toMcpToolResult({
        databases: rows.map((row) => ({
          name: getRowValue(row, 'name') ?? null,
          kind: getRowValue(row, 'kind') ?? null,
          comment: getRowValue(row, 'comment') ?? null,
          owner: getRowValue(row, 'owner') ?? null,
        })),
      });
    },
  );

  server.registerTool(
    'list_schemas',
    {
      title: 'List Schemas',
      description: 'List schemas in a Snowflake database.',
      inputSchema: {
        database: nonEmptyStringSchema.describe(
          'Non-empty database name to inspect for schemas.',
        ),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: {
        ...TOOL_ANNOTATIONS,
        readOnlyHint: true,
      },
    },
    async ({ database }) => {
      const databaseName = parseIdentifier(database, 1, 'database')[0]!;
      const sql = `SHOW SCHEMAS IN DATABASE ${quoteQualifiedName(databaseName)}`;
      const rows = await withSnowflakeConnection(
        connectionConfig,
        (connection) => executeQuery(connection, sql),
      );

      return toMcpToolResult({
        schemas: rows.map((row) => ({
          name: getRowValue(row, 'name') ?? null,
          database: getRowValue(row, 'database_name') ?? databaseName,
          owner: getRowValue(row, 'owner') ?? null,
          comment: getRowValue(row, 'comment') ?? null,
        })),
      });
    },
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List Tables',
      description: 'List tables in a Snowflake schema.',
      inputSchema: {
        database: nonEmptyStringSchema.describe(
          'Non-empty database name containing the schema.',
        ),
        schema: nonEmptyStringSchema.describe(
          'Non-empty schema name to inspect for tables.',
        ),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: {
        ...TOOL_ANNOTATIONS,
        readOnlyHint: true,
      },
    },
    async ({ database, schema }) => {
      const databaseName = parseIdentifier(database, 1, 'database')[0]!;
      const schemaName = parseIdentifier(schema, 1, 'schema')[0]!;
      const sql = `SHOW TABLES IN SCHEMA ${quoteQualifiedName(databaseName, schemaName)}`;
      const rows = await withSnowflakeConnection(
        connectionConfig,
        (connection) => executeQuery(connection, sql),
      );

      return toMcpToolResult({
        tables: rows.map((row) => ({
          name: getRowValue(row, 'name') ?? null,
          database: getRowValue(row, 'database_name') ?? databaseName,
          schema: getRowValue(row, 'schema_name') ?? schemaName,
          kind: getRowValue(row, 'kind') ?? null,
          comment: getRowValue(row, 'comment') ?? null,
        })),
      });
    },
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe Table',
      description:
        'Describe a Snowflake table and return column metadata as JSON.',
      inputSchema: {
        table_name: nonEmptyStringSchema.describe(
          'Non-empty fully-qualified table name in database.schema.table format.',
        ),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: {
        ...TOOL_ANNOTATIONS,
        readOnlyHint: true,
      },
    },
    async ({ table_name: tableName }) => {
      const [databaseName, schemaName, relationName] = parseIdentifier(
        tableName,
        3,
        'table_name',
      ) as [string, string, string];
      const sql = `DESCRIBE TABLE ${quoteQualifiedName(
        databaseName,
        schemaName,
        relationName,
      )}`;
      const rows = await withSnowflakeConnection(
        connectionConfig,
        (connection) => executeQuery(connection, sql),
      );

      return toMcpToolResult({
        table: {
          database: databaseName,
          schema: schemaName,
          name: relationName,
        },
        columns: rows.map((row) => ({
          name: getRowValue(row, 'name') ?? null,
          type: getRowValue(row, 'type') ?? null,
          nullable:
            String(getRowValue(row, 'null?') ?? '')
              .trim()
              .toUpperCase() === 'Y',
          comment: getRowValue(row, 'comment') ?? null,
        })),
      });
    },
  );
}
