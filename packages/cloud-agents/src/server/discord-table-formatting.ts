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
  '  <rule>Keep each Discord reply, including its code fence, within 2,000 characters (prefer at most 1,900). Never send one oversized table and rely on automatic message chunking to preserve it.</rule>',
  '  <rule>If a table is longer, send it through separate `send_chat_reply` calls as multiple complete table blocks. Split only at row boundaries, and repeat the header and separator in every block so each message is understandable on its own. Balance all triple-backtick fences in each message; use `progress` for non-final chunks and `closeout` only for the final chunk.</rule>',
  '  <rule>Wrap long cell text at word boundaries where possible. If an unbroken value (such as a URL or token) exceeds the remaining budget, hard-wrap at a character boundary into labeled continuation lines that repeat the row and column labels. Preserve every value character and do not rely on generic provider chunking.</rule>',
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
