/**
 * Provider-specific output guidance shared by the standard Discord workflow
 * and Fast-agent Discord turns.
 */
export const DISCORD_TABLE_FORMATTING_INSTRUCTIONS = [
  '<discord_table_formatting>',
  '  <rule>Discord displays Markdown pipe tables literally. When a table improves clarity, format it as a padded ASCII table in a triple-backtick code fence, with aligned columns and a header/separator row; preserve wide columns and keep cell text plain.</rule>',
  '  <rule>Keep each Discord reply under 2,000 characters. Send longer tables as separate complete blocks that repeat the header and separator; wrap overlong values as labeled continuations instead of relying on provider chunking.</rule>',
  '</discord_table_formatting>',
].join('\n');
