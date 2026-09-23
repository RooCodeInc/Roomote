/**
 * Provider-specific output guidance shared by the standard Discord workflow
 * and Fast-agent Discord turns.
 */
export const DISCORD_TABLE_FORMATTING_INSTRUCTIONS = [
  '<discord_table_formatting>',
  '  <rule>When a table makes a Discord reply clearer, generate it directly as a padded ASCII table inside a triple-backtick code fence. Use a header, an ASCII separator row, and spaces that align the cells in the monospace block.</rule>',
  '  <rule>Do not output GFM/Markdown pipe-table syntax for Discord; Discord displays it literally. Use the fenced ASCII format below.</rule>',
  '  <rule>Keep wide columns and all cell content; horizontal scrolling is acceptable. Do not switch to labeled entries only because a table is wide. Keep cell content plain text and express links as a readable label and URL.</rule>',
  '  <rule>Use exactly three backticks around the table. Avoid literal triple-backtick sequences in table cells so the fence stays closed.</rule>',
  '  <example>',
  '  ```',
  '  +----------+---------+',
  '  | Provider | Result  |',
  '  +==========+=========+',
  '  | Example  | Ready   |',
  '  +----------+---------+',
  '  ```',
  '  </example>',
  '</discord_table_formatting>',
].join('\n');
