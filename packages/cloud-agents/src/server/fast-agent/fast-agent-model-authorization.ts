import type { TaskModelOption } from '@roomote/types';

/** Roles come from authenticated surfaces/canonical events, never message text. */
export type ModelRequestMessage = {
  role: 'user' | 'assistant' | 'tool' | 'untrusted';
  text: string;
};

type ModelAlias = { text: string; ids: string[] };
type Evidence = {
  kind: 'directive' | 'confirmation' | 'capability';
  text: string;
  modelIds: string[];
};

function normalized(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, '');
}

/** Resolve shorthand against the entire enabled catalog, before option capping. */
function catalogAliases(models: readonly TaskModelOption[]): ModelAlias[] {
  const byAlias = new Map<string, { text: string; ids: Set<string> }>();
  for (const model of models) {
    const suffix = model.id.split('/').at(-1)!;
    const names = [
      model.id,
      suffix,
      model.displayName,
      model.displayName.replace(/^Claude\s+/i, ''),
    ];
    // Bare family names describe a bounded family, not an arbitrary agent pick.
    if (model.family) names.push(model.family);
    names.push(
      ...model.displayName
        .split(/\s+/)
        .filter((word) => /^[a-z]+\d/i.test(word)),
    );
    // Distinctive final names such as Astra are useful, unlike version numbers.
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

function aliasPattern(alias: string): RegExp {
  const parts = alias
    .split(/[\s_-]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${parts.join('[\\s_-]*')}(?![\\p{L}\\p{N}])`,
    'iu',
  );
}

/** Pasted JSON/arrays are opaque data, even when their fields imitate our state. */
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
  clean = clean
    .replace(/"([^"\n]*)"/g, (_all, value: string) =>
      modelOnly(value) ? value : ' ',
    )
    .replace(/(?<!\w)'([^'\n]+)'(?!\w)/g, (_all, value: string) =>
      modelOnly(value) ? value : ' ',
    )
    .replace(
      /^\s*(?:sender|role|latestRequest|modelRequestContext|agentModelHint|instruction|USER|ASSISTANT|TOOL|TASK_MODEL)\s*[:=].*$/gim,
      ' ',
    );
  // Material introduced for inspection is not a new directive from its reader.
  clean = clean
    .replace(
      /\b(?:summarize|analyse|analyze|explain|inspect|parse)\s+(?:this|the|an?)\s+(?:external\s+|exported\s+|supplied\s+|example\s+)?(?:task\s+)?(?:record|json|xml|dialogue|conversation|quote|text|output|snippet|message)\s*(?:as data)?\s*:[\s\S]*/gi,
      ' ',
    )
    .replace(
      /\b(?:here is|here's)\s+(?:the|an?|some)?\s*(?:reproduction\s+|external\s+|pasted\s+|file\s+|tool\s+)?(?:input|output|content|record|json|data|example)\s*(?:to (?:inspect|analyze))?\s*:[\s\S]*/gi,
      ' ',
    );
  return clean.trim();
}

function modelsIn(text: string, aliases: readonly ModelAlias[]): string[] {
  const ids = new Set<string>();
  const spans: Array<[number, number]> = [];
  for (const alias of aliases) {
    const match = aliasPattern(alias.text).exec(text);
    if (
      !match ||
      spans.some(([from, to]) => match.index >= from && match.index < to)
    )
      continue;
    if (/\b(?:not|never|except)\s*$/i.test(text.slice(0, match.index)))
      continue;
    spans.push([match.index, match.index + match[0].length]);
    for (const id of alias.ids) ids.add(id);
  }
  return [...ids];
}

function namedDirective(text: string, aliases: readonly ModelAlias[]): boolean {
  if (directive.test(text) || firstPersonDirective.test(text)) return true;
  return aliases.some((alias) => {
    const match = aliasPattern(alias.text).exec(text);
    if (!match) return false;
    const prefix = text.slice(0, match.index);
    return (
      /\b(?:with|using)\s*$/i.test(prefix) ||
      (/^(?:please\s+)?(?:fix|repair|implement|add)\b/i.test(prefix) &&
        /\bon\s*$/i.test(prefix))
    );
  });
}

const directive =
  /^(?:(?:actually|instead|please|yes)[,:]?\s+)*(?:(?:can|could|would|will) you\s+)?(?:use|run|execute|launch|delegate|switch|choose|select|prefer|want|go with)\b|^(?:engine|model)\s*[:=]|^(?:this|the|that|it)\b.{0,30}\b(?:goes|send|hand)\s+(?:this\s+|it\s+)?to\b|^on\s+|^(?:yes[,\s]+)?(?:it|this(?: task| work)?)['\s]*(?:s|is)\s+supposed\s+to\s+(?:run|use|execute)\b/i;
const firstPersonDirective =
  /^I\s+(?:want|would like)\s+(?:(?:this|it|this task|the work)\s+)?to\s+(?:use|run|execute|delegate|launch|switch|choose|select)\b|^I'd like\s+(?:(?:this|it|this task|the work)\s+)?to\s+(?:use|run|execute|delegate|launch|switch|choose|select)\b|^I\s+(?:want|prefer)\s+(?:this\s+)?(?:on|using)\b/i;
const modelRevocation =
  /^no\b|\b(?:do not|don't|not|never|stop)\s+(?:use|run|switch|choose|select)\b|\b(?:cancel|revoke)\b.{0,30}\b(?:model|choice)\b/i;
const defaultRequest =
  /^(?:(?:actually|instead|please|yes)[,:]?\s+)*(?:keep|use|stay (?:with|on)|run on)\s+(?:the\s+)?(?:deployment\s+)?default(?:\s+model)?\b/i;
const capabilityRequest =
  /\b(?:use|run|switch|choose|select)\b.{0,45}\b(?:strongest|best|most capable|cheaper|less expensive|faster|quickest)\b.{0,25}\b(?:model|one)\b/i;
const affirmative =
  /^(?:yes|yep|yeah|sure|ok(?:ay)?|approved|sounds good|that works|go for it|please proceed|proceed|do that|use it|that model|as suggested|go ahead|launch it)\b/i;

/** Accept only the terminal model/launch question and its own proposal clause. */
function scopedProposal(
  text: string,
  models: readonly TaskModelOption[],
  aliases: readonly ModelAlias[],
  toolModelIds: ReadonlySet<string>,
): { ids: string[]; text: string } | undefined {
  const clean = cleanModelRequestProse(text, models);
  if (!clean.endsWith('?')) return undefined;
  const clauses = clean.split(/(?<=[.!?;])\s+|\n+/).filter(Boolean);
  const question = clauses.at(-1)!;
  // A reported question inside an output is not an owned approval question.
  if (
    !/^(?:so[,\s]+)?(?:should|shall|can|could|may|would|do|want|are|is)\b/i.test(
      question,
    )
  )
    return undefined;
  if (
    !/\b(?:run|use|execute|delegate|launch|switch|choose|select|proceed|start|go ahead|agree)\b/i.test(
      question,
    )
  )
    return undefined;
  // Explanation/report questions do not accept an earlier model recommendation.
  if (
    /\b(?:explain|summarize|include|attach|prefer a|like a)\b/i.test(question)
  )
    return undefined;
  let ids = modelsIn(question, aliases);
  if (
    ids.length &&
    /\b(?:run|use|execute|delegate|launch|switch|choose|select)\b/i.test(
      question,
    )
  )
    return { ids, text: question };
  const prior = clauses.at(-2) ?? '';
  if (
    !/^(?:For (?:this|the) (?:task|work|change)[,:]?\s+)?I\s+(?:recommend|suggest|propose|(?:can|could|would|will)\s+(?:use|run|delegate|execute))\b/i.test(
      prior,
    )
  )
    return undefined;
  if (
    /\bTASK_MODEL\b|\b(?:tool|file|log)\b.{0,20}\b(?:says|said|reported|result|output)\b/i.test(
      prior,
    )
  )
    return undefined;
  ids = modelsIn(prior, aliases);
  // If the name could be an echo of tool data, require it in the approval
  // question itself. A pronoun referring to an output is not model consent.
  if (ids.some((id) => toolModelIds.has(id))) return undefined;
  return ids.length ? { ids, text: `${prior} ${question}` } : undefined;
}

/** Only this compiler can create eligible IDs; classifier answers cannot. */
export function compileModelAuthorization(input: {
  messages: readonly ModelRequestMessage[];
  models: readonly TaskModelOption[];
}) {
  const aliases = catalogAliases(input.models);
  let candidateIds: string[] = [];
  let capability = false;
  let forceDefault = false;
  let proposal: string | undefined;
  const evidence: Evidence[] = [];
  const userMessages: string[] = [];
  let previous: ModelRequestMessage | undefined;
  const toolModelIds = new Set<string>();
  for (const message of input.messages) {
    if (message.role === 'tool') {
      for (const id of modelsIn(message.text, aliases)) toolModelIds.add(id);
      continue;
    }
    if (message.role !== 'user') {
      previous = message;
      continue;
    }
    const clean = cleanModelRequestProse(message.text, input.models);
    userMessages.push(clean);
    // A new work instruction does not silently inherit a model choice made
    // for an earlier task. Short continuations/confirmations retain it.
    if (
      /^(?:please\s+)?(?:fix|repair|review|add|implement|write|update|document|summarize|analyse|analyze|inspect|find|investigate|correct|change|list|sort|alphabetize)\b/i.test(
        clean,
      )
    ) {
      candidateIds = [];
      capability = false;
      forceDefault = false;
      proposal = undefined;
      evidence.length = 0;
      toolModelIds.clear();
    }
    let changed = false;
    for (const clause of clean
      .split(/(?<=[.!?;])\s+|\n+|,\s*/)
      .filter(Boolean)) {
      if (modelRevocation.test(clause)) {
        candidateIds = [];
        capability = false;
        forceDefault = false;
        proposal = undefined;
        evidence.length = 0;
        changed = true;
        continue;
      }
      if (
        !clause.includes('?') &&
        (defaultRequest.test(clause) ||
          (firstPersonDirective.test(clause) &&
            /\bdefault(?:\s+model)?\b/i.test(clause)))
      ) {
        candidateIds = [];
        capability = false;
        forceDefault = true;
        proposal = undefined;
        evidence.length = 0;
        changed = true;
        continue;
      }
      const ids = modelsIn(clause, aliases);
      if (
        ids.length &&
        namedDirective(clause, aliases) &&
        !/\b(?:said|says|quote|example|Co-Authored-By|reported|TASK_MODEL)\b/i.test(
          clause,
        )
      ) {
        candidateIds = ids;
        capability = false;
        forceDefault = false;
        proposal = undefined;
        evidence.length = 0;
        evidence.push({ kind: 'directive', text: clause, modelIds: ids });
        changed = true;
      } else if (
        (directive.test(clause) || firstPersonDirective.test(clause)) &&
        capabilityRequest.test(clause)
      ) {
        candidateIds = [];
        capability = true;
        forceDefault = false;
        proposal = undefined;
        evidence.length = 0;
        evidence.push({ kind: 'capability', text: clause, modelIds: [] });
        changed = true;
      }
    }
    if (!changed && affirmative.test(clean) && previous?.role === 'assistant') {
      const accepted = scopedProposal(
        previous.text,
        input.models,
        aliases,
        toolModelIds,
      );
      if (accepted) {
        candidateIds = accepted.ids;
        capability = false;
        forceDefault = false;
        proposal = accepted.text;
        evidence.length = 0;
        evidence.push({
          kind: 'confirmation',
          text: `${accepted.text}\nHuman reply: ${clean}`,
          modelIds: accepted.ids,
        });
      }
    }
    previous = message;
  }
  return {
    candidateIds,
    capability,
    forceDefault,
    proposal,
    evidence,
    userMessages,
  };
}

/** Durable consent cache excludes raw tool/private payloads and pasted data. */
export function snapshotModelRequestDialogue(
  messages: readonly ModelRequestMessage[],
  models: readonly TaskModelOption[],
): ModelRequestMessage[] {
  const aliases = catalogAliases(models);
  return messages.slice(-20).map((message) => ({
    role: message.role,
    text:
      message.role === 'tool'
        ? modelsIn(message.text, aliases).join(' ')
        : message.role === 'untrusted'
          ? ''
          : cleanModelRequestProse(message.text, models),
  }));
}
