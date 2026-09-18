/**
 * Model-neutral context checkpoint for resumed Roomote tasks.
 * Preserves operational state and the exact next-step instruction reload set.
 */
export const ROOMOTE_COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a concise operational handoff for another model to resume the task, not a chronological reconstruction of the conversation.

Keep information that changes what the next model should do. Deduplicate repeated facts and omit obsolete history, routine tool output, and code that can be reread from files. Prefer exact paths, symbols, commands, and artifact references over copied source; retain a small snippet or exact error only when necessary to continue safely. Do not impose a fixed length budget or discard unresolved obligations for brevity.

Output only the handoff inside <summary> and </summary>, with the sections below. Give decisions and brief rationale, not private analysis or a thought-process transcript. Mark unknown or unverified state explicitly; never turn an intention, queued action, or attempted command into a completed result.

1. User Intent and Constraints
Preserve the current goal, acceptance criteria, explicit user requests, corrections, preferences, and scoped approvals or denials. Quote exact wording when it affects execution. Apply the latest correction and identify any superseded instruction that could otherwise mislead the next model; do not reproduce all user messages or infer authorization.

2. Decisions and Rationale
Record consequential decisions, why they were made, and rejected approaches or failed attempts only when they prevent repeated mistakes. Separate established facts from hypotheses. Keep only technical context needed for continuation.

3. Current State
Describe exactly where work stopped: repository/workspace paths, branch, relevant files or symbols, and implemented versus planned changes. Distinguish this task's edits from dirty work authored by the user or other agents, including unknown ownership; preserve work not authored by this task. Record known commit, push, and PR state with exact identifiers or links. For validation and proof, retain commands/results and artifact paths or URLs, distinguishing passed, failed, pending, skipped, blocked, or stale evidence. Do not claim checks or delivery occurred without evidence.

4. Unresolved Obligations and Blockers
Carry forward unfinished user requests and parent/child workflow obligations, including validation, proof, review, delivery, reporting, and input needs. State blockers, dependencies, and the exact decision or external change needed to proceed. Completed implementation does not imply these obligations are complete.

5. Required Reloads Before Action
Record the active workflow, phase, execution mode, and in-flight constraints. Name each skill that must be reloaded on resume before continuing, its exact known path, and any supporting resource paths or sections required for the immediate next step. Include the exact \`AGENTS.md\` paths that were actually read or governed the current work and still apply to that step. For every entry, state why it is needed now. Preserve relevant parent/child delegation and return obligations without copying entire skill or guidance bodies.
Include only next-step-needed skills, supporting resources, and applicable \`AGENTS.md\` files. Exclude completed, superseded, or no-longer-relevant earlier-phase instructions. Do not tell the next model to reload every \`AGENTS.md\` in the workspace or eagerly load resources for later phases. Do not invent paths; flag any missing required path as a reload blocker.
The first and only allowed actions after resume are reloading the exact skills, supporting resources, and \`AGENTS.md\` files named in this reload set before any other action. If a required reload is unavailable, report the blocker rather than continuing without it. The summary is not a substitute for those instructions.

6. Next Action
After the required reloads, specify the concrete next action at the point work stopped, with its target path or command and expected result. If blocked, identify the input or condition needed instead of inventing executable work. Keep later obligations in the unresolved list, not an exhaustive future plan.`;
