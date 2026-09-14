---
"@roomote/web": patch
---

Fast sessions now reject integration tool calls that pass undeclared argument keys, such as chat history bounds wrapped in a stringified `args` field, with an error naming the accepted arguments. Previously the MCP server silently dropped those keys, so the default 24-hour history window applied and the model kept repeating the malformed shape.
