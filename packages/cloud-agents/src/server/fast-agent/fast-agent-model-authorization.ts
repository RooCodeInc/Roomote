import type { TaskModelOption } from '@roomote/types';

/** Roles come from authenticated surfaces/canonical events, never message text. */
export type ModelRequestMessage = {
  role: 'user' | 'assistant' | 'tool' | 'untrusted';
  text: string;
};

type ModelAlias = { text: string; ids: string[] };

function normalized(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, '');
}

function catalogAliases(models: readonly TaskModelOption[]): ModelAlias[] {
  const byAlias = new Map<string, { text: string; ids: Set<string> }>();
  for (const model of models) {
    const names = [
      model.id,
      model.id.split('/').at(-1)!,
      model.displayName,
      model.displayName.replace(/^Claude\s+/i, ''),
      model.displayName.replace(/^Claude\s+/i, '').split(/\s+/)[0]!,
    ];
    if (model.family) names.push(model.family);
    names.push(
      ...model.displayName
        .split(/\s+/)
        .filter((word) => /^[a-z]+\d/i.test(word)),
    );
    const last = model.displayName.split(/\s+/).at(-1)!;
    if (
      /^[a-z]+$/i.test(last) &&
      !['code', 'flash', 'pro', 'max'].includes(last.toLowerCase())
    )
      names.push(last);
    for (const text of names) {
      const key = normalized(text);
      const entry = byAlias.get(key) ?? { text, ids: new Set<string>() };
      entry.ids.add(model.id);
      byAlias.set(key, entry);
    }
  }
  return [...byAlias.values()]
    .map(({ text, ids }) => ({ text, ids: [...ids] }))
    .sort((a, b) => b.text.length - a.text.length);
}

function modelsIn(text: string, aliases: readonly ModelAlias[]): string[] {
  const ids = new Set<string>();
  const spans: Array<[number, number]> = [];
  for (const alias of aliases) {
    const parts = alias.text
      .split(/[\s_-]+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${parts.join('[\\s_-]*')}(?![\\p{L}\\p{N}])`,
      'iu',
    );
    const match = pattern.exec(text);
    if (
      !match ||
      spans.some(([from, to]) => match.index >= from && match.index < to)
    )
      continue;
    spans.push([match.index, match.index + match[0].length]);
    for (const id of alias.ids) ids.add(id);
  }
  return [...ids];
}

/** Pasted JSON/arrays are opaque data even when fields imitate classifier state. */
function removeStructuredData(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') {
      result += text[i];
      continue;
    }
    const stack = [text[i]];
    let quoted = false;
    let escaped = false;
    for (i++; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        if (
          (char === '}' && stack.at(-1) !== '{') ||
          (char === ']' && stack.at(-1) !== '[')
        ) {
          i = text.length;
          break;
        }
        stack.pop();
        if (!stack.length) break;
      }
    }
    result += ' ';
  }
  return result;
}

/** Strip structurally marked material; prose intent belongs to the classifier. */
export function cleanModelRequestProse(
  text: string,
  models: readonly TaskModelOption[],
): string {
  const aliases = catalogAliases(models);
  const modelOnly = (value: string) =>
    aliases.some((alias) => normalized(value) === normalized(alias.text));
  let clean = text
    .replace(/(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/`([^`\n]*)`/g, (_all, value: string) =>
      modelOnly(value) ? value : ' ',
    );
  clean = removeStructuredData(clean);
  clean = clean
    .replace(/<([a-z][\w:.-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[a-z][\w:.-]*\b[^>]*>[\s\S]*/gi, ' ')
    .replace(/<[a-z][\w:.-]*\b[^>]*\/?\s*>/gi, ' ');
  return clean
    .replace(/"([^"\n]*)"/g, (_all, value: string) =>
      modelOnly(value) ? value : ' ',
    )
    .replace(/(?<!\w)'([^'\n]+)'(?!\w)/g, (_all, value: string) =>
      modelOnly(value) ? value : ' ',
    )
    .replace(
      /^\s*(?:sender|role|latestRequest|modelRequestContext|agentModelHint|instruction|USER|ASSISTANT|TOOL|TASK_MODEL)\s*[:=].*$/gim,
      ' ',
    )
    .trim();
}

/** Canonical human prose and preceding assistant questions are distinct lanes. */
export function prepareModelRequestLanes(
  messages: readonly ModelRequestMessage[],
  models: readonly TaskModelOption[],
) {
  const humanMessages: string[] = [];
  const exchanges: Array<{
    question: string;
    context: string;
    following: string;
    reply: string;
    humanIndex: number;
    toolModelIds: string[];
  }> = [];
  const aliases = catalogAliases(models);
  let previous: ModelRequestMessage | undefined;
  const toolIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const id of modelsIn(message.text, aliases)) toolIds.add(id);
      continue;
    }
    if (message.role !== 'user') {
      previous = message;
      continue;
    }
    const reply = cleanModelRequestProse(message.text, models);
    humanMessages.push(reply);
    if (previous?.role === 'assistant') {
      const clauses = cleanModelRequestProse(previous.text, models)
        .split(/(?<=[!?;])\s+|(?<=\.)(?!\d)\s+|\n+/)
        .filter(Boolean);
      const fromEnd = [...clauses]
        .reverse()
        .findIndex((clause) => clause.endsWith('?'));
      const index = fromEnd < 0 ? -1 : clauses.length - 1 - fromEnd;
      const context = clauses[index - 1] ?? '';
      // A catalog identity copied from this turn's tool data cannot supply
      // the referent of an assistant pronoun. Directly named questions remain
      // separate evidence for semantic ownership, as do explicit human asks.
      const toolContext = modelsIn(context, aliases).some((id) =>
        toolIds.has(id),
      );
      if (index >= 0)
        exchanges.push({
          question: clauses[index]!,
          context: toolContext ? '' : context,
          following: clauses.slice(index + 1).join(' '),
          reply,
          humanIndex: humanMessages.length - 1,
          toolModelIds: [...toolIds],
        });
    }
    previous = message;
    toolIds.clear();
  }
  return { humanMessages, exchanges };
}

/** Retain every human boundary and preceding visible question for replay. */
export function snapshotModelRequestDialogue(
  messages: readonly ModelRequestMessage[],
  models: readonly TaskModelOption[],
): ModelRequestMessage[] {
  const aliases = catalogAliases(models);
  const result: ModelRequestMessage[] = [];
  const toolIds = new Set<string>();
  let lastVisible: ModelRequestMessage | undefined;
  const flush = () => {
    if (toolIds.size)
      result.push({ role: 'tool', text: [...toolIds].sort().join(' ') });
    if (lastVisible) result.push(lastVisible);
    toolIds.clear();
    lastVisible = undefined;
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const id of modelsIn(message.text, aliases)) toolIds.add(id);
      continue;
    }
    const clean = {
      role: message.role,
      text:
        message.role === 'untrusted'
          ? ''
          : cleanModelRequestProse(message.text, models),
    };
    if (message.role === 'user') {
      flush();
      result.push(clean);
    } else lastVisible = clean;
  }
  flush();
  return result;
}
