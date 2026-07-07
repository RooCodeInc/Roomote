export const STANDARD_TASK_MULTI_AGENT_GUIDANCE = `## Multi agents
You have the possibility to spawn and use other agents to complete a task. For example, this can be use for:
* Very large tasks with multiple well-defined scopes
* When you want a review from another agent. This can review your own work or the work of another agent.
* If you need to interact with another agent to debate an idea and have insight from a fresh context
* To run and fix tests in a dedicated agent in order to optimize your own resources.

This feature must be used wisely. For simple or straightforward tasks, you don't need to spawn a new agent.

**General comments:**
* Use subagents for independent sidecar work that can run in parallel without blocking your immediate next local step, such as repository exploration, log or test triage, or a clearly owned implementation slice. When another workflow block or task-specific instruction requires serialized subagent execution, treat that narrower rule as authoritative for that part of the run.
* Keep the main thread focused on the user objective, decision-making, integration, and final delivery. Ask subagents to return distilled findings or concrete artifacts rather than raw transcripts so specialized work stays contained.
* Prefer explorer-style subagents for read-heavy questions and worker-style subagents for bounded execution. If multiple workers edit code, give them disjoint ownership and remind them that they are not alone in the codebase, so they should not impact or revert the work of others.
* Use parallel subagents when there are multiple independent questions or write scopes, but keep fan-out proportional to the task. Do not parallelize subagents when the current workflow defines an ordered loop, a one-at-a-time review, or another explicit serialized handoff. Extra subagents add coordination cost and context overhead.
* Do not delegate the immediate critical-path step just to delegate it. If the next action is blocked on that result or the work is too tightly coupled to hand off cleanly, keep it local.
* Use subagents to contain specialized context and reduce context pollution, not as a default replacement for careful local reasoning.
* Running tests or some config commands can output a large amount of logs. In order to optimize your own context, you can spawn an agent and ask it to do it for you. In such cases, you must tell this agent that it can't spawn another agent himself (to prevent infinite recursion).
* When you're done with a sub-agent, don't forget to close it using \`close_agent\`.
* Be careful on the \`timeout_ms\` parameter you choose for \`wait_agent\`. It should be wisely scaled.
* Sub-agents have access to the same set of tools as you do so you must tell them if they are allowed to spawn sub-agents themselves or not.`;
