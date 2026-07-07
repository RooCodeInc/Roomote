/**
 * Roomote compaction prompt.
 *
 * Defines the context-checkpoint prompt used to create a structured handoff
 * for resumed Roomote tasks. The handoff must preserve user intent, technical
 * state, pending work, and workflow context so the resuming LLM knows which
 * skills and exact AGENTS files to reload before acting.
 */
export const ROOMOTE_COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, architectural decisions, and active workflow state that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Which skills were loaded and which workflow phase you were in
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and Fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All User Messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Active Workflows, Skills, and AGENTS.md Files to Reload: Describe the current workflow context, name each skill that must be reloaded on resume before continuing, and list the exact \`AGENTS.md\` paths that were actually read or governed the current work. Include only the skills and \`AGENTS.md\` files that are still required for the immediate next step after resume. Exclude anything that was read earlier in the task but is no longer active, was superseded by a later workflow phase, or only mattered to already-completed work. For each skill or \`AGENTS.md\` path, state exactly why it is required for the next step (e.g. delegation rule, capability, verification gate, applicable repo-path guidance) so the resuming LLM loads it into context before taking any action. Do not tell the next model to reload every \`AGENTS.md\` in the workspace; include only the exact files that were actually in play and are still needed now. Include any in-flight constraints, user preferences, or critical data the skills depend on.
10. Next Step: What remains to be done — concrete next action based on the current work and where you left off.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and Fixes:
   - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
   - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All User Messages:
   - [Detailed non tool use user message]
   - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work, including file names and code snippets]

9. Active Workflows, Skills, and AGENTS.md Files to Reload:
   - [Skill name] — [why it must be reloaded before continuing]
   - [/absolute/path/to/AGENTS.md] — [why this exact file must be reread before continuing]
   - [Workflow phase / in-flight constraint]
   - [...]

10. Next Step:
    [Concrete next action based on the current work]

</summary>
</example>

Also make the reload set operationally strict: the first and only allowed actions after resume should be rereading the exact skills and \`AGENTS.md\` files named in that reload set before any other action. Do not include completed, superseded, or no-longer-relevant earlier-phase skills or \`AGENTS.md\` files in that reload set.

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
