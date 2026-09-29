/** Match only a standalone stop command, optionally preceded by the bot mention
 * included in Slack and Microsoft Teams message text. */
export function isStopSessionCommandText(text: string): boolean {
  const command = text
    .trim()
    .replace(/^(?:(?:<@[^>]+>|<at>[^<]+<\/at>)\s*)+/iu, '')
    .trim();
  return /^\/?stop(?:\s+tasks?)?$/iu.test(command);
}
