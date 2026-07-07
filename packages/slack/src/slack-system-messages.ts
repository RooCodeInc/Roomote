export const SLACK_ROUTING_WAIT_REPLY_TEXT =
  "I'm still starting the task from this thread. Please wait a moment, then send another reply if I still missed it.";

export function formatSlackRoutingWaitReplyText(): string {
  return `_${SLACK_ROUTING_WAIT_REPLY_TEXT}_`;
}

export function isSlackRoutingWaitReplyText(text: string): boolean {
  return text.includes(SLACK_ROUTING_WAIT_REPLY_TEXT);
}
