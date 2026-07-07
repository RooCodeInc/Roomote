# LLM Evaluations

This directory contains evaluation suites for Roomote's LLM-driven behavior, using [promptfoo](https://promptfoo.dev/) to test and validate production prompts and routing decisions.

## Overview

The routing evaluations ensure the LLM router correctly:

- Selects the appropriate agent type (Coder, Explainer, Planner, Fixer, PrReviewer)
- Chooses the correct workspace scope (repository, environment, all_repositories, etc.)
- Produces appropriate confidence scores based on context clarity
- Handles edge cases and adversarial inputs gracefully

The authorship evaluations ensure the authorship-rules compiler correctly:

- Compiles deterministic natural-language authorship instructions into structured rules
- Preserves narrow source/repository/user conditions from user-entered guidance
- Refuses ambiguous or subjective instructions instead of guessing
- Carries forward concrete portions of mixed guidance while flagging unclear portions

## Prerequisites

Ensure your promptfoo provider credentials are available in the environment
loaded by dotenvx. Runtime routing uses `ROOMOTE_SMALL_MODEL`, falling back
to `ROOMOTE_MODEL`; these evals are standalone promptfoo suites.

Provider ids default to `openrouter:anthropic/claude-haiku-4.5`. Override them
with `ROUTER_EVAL_PROVIDER`, `ROUTER_FOLLOWUP_EVAL_PROVIDER`, or
`AUTHORSHIP_RULES_EVAL_PROVIDER` when testing a different promptfoo provider.

## Running Evaluations

### Run Full Eval Suite

From the repo root or this directory:

```bash
pnpm evals
```

### Run the Router Eval Suite

```bash
cd packages/cloud-agents/evals/router
npx promptfoo eval
```

### Run the Authorship Eval Suite

```bash
cd packages/cloud-agents/evals/authorship
npx promptfoo eval
```

### Run with Verbose Output

```bash
npx promptfoo eval --verbose
```

### Filter by Test Description

Run only tests matching a pattern:

```bash
npx promptfoo eval --filter-description "adversarial"
npx promptfoo eval --filter-description "Coder"
```

### Filter by Dataset File

Run tests from specific dataset files by modifying the `tests` array in [`promptfooconfig.ts`](router/promptfooconfig.ts):

```javascript
tests: [
  // Comment out datasets you don't want to run
  // 'file://datasets/basic.yaml',
  // 'file://datasets/workspace-scope.yaml',
  // 'file://datasets/agent-selection.yaml',
  // 'file://datasets/workspace-selection.yaml',
  // 'file://datasets/edge-cases.yaml',
  'file://datasets/adversarial.yaml',  // Only run adversarial tests
],
```

### Limit Number of Tests

```bash
npx promptfoo eval --max-concurrency 1  # Run tests sequentially
```

## Viewing Results

### Web UI (Recommended)

Launch the interactive results viewer:

```bash
npx promptfoo view
```

This opens a browser with:

- Pass/fail status for each test
- Side-by-side comparison of expected vs actual outputs
- Detailed assertion results
- Filtering and sorting capabilities

### JSON Output

Results are automatically saved to each suite's `results/eval-results.json` after each run.

### Terminal Table

After running `npx promptfoo eval`, a summary table is displayed in the terminal.

## Directory Structure

```
evals/
├── authorship/
│   ├── promptfooconfig.ts
│   ├── prompts/
│   │   └── compile-authorship.ts
│   ├── datasets/
│   │   └── convoluted-and-ambiguous.yaml
│   ├── assertions/
│   │   └── authorship-assertions.ts
│   └── results/
│       └── eval-results.json
└── router/
    ├── promptfooconfig.ts
    ├── prompts/
    │   └── routing.ts
    ├── datasets/
    │   ├── basic.yaml
    │   ├── agent-selection.yaml
    │   ├── workspace-scope.yaml
    │   ├── workspace-selection.yaml
    │   ├── edge-cases.yaml
    │   └── adversarial.yaml
    ├── assertions/
    │   └── routing-assertions.ts
    └── results/
        └── eval-results.json
```

## Defining Test Subsets

### In `promptfooconfig.ts`

The `tests` array controls which dataset files are included:

```javascript
tests: [
  'file://datasets/basic.yaml',
  'file://datasets/adversarial.yaml',
  // Add or comment out as needed
],
```

### Creating a Temporary Config

For ad-hoc testing, create a temporary config:

```bash
# Create a minimal config for quick iteration
cat > /tmp/quick-eval.js << 'EOF'
import baseConfig from './promptfooconfig.ts';
export default {
  ...baseConfig,
  tests: ['file://datasets/basic.yaml'],
};
EOF

npx promptfoo eval -c /tmp/quick-eval.js
```

## Writing Test Cases

Test cases are defined in YAML files under `datasets/`. Each test has:

```yaml
- description: 'Human-readable test name'
  vars:
    context: |
      **Task Description**:
      Your task description here...

      **Available Agents**:
      - AgentName (AgentType)

      **Available Repositories**:
      - org/repo: Description
  assert:
    - type: contains-json # Verify valid JSON output
    - type: javascript
      value: file://assertions/routing-assertions.js:agentTypeEqualsCoder
    - type: javascript
      value: file://assertions/routing-assertions.js:confidenceAtLeast80
```

### Available Pre-bound Assertions

From [`assertions/routing-assertions.js`](router/assertions/routing-assertions.js):

**Agent Type:**

- `agentTypeEqualsCoder`
- `agentTypeEqualsExplainer`
- `agentTypeEqualsPlanner`
  **Workspace Selection:**
- `hasValidWorkspaceValue`
- `workspaceValueMatchesExpected`

**Confidence Thresholds:**

- `confidenceAtLeast50` through `confidenceAtLeast95`
- `confidenceBelow50` through `confidenceBelow90`

### Inline Assertions

For one-off checks, use inline JavaScript:

````yaml
assert:
  - type: javascript
    value: |
      const match = output.match(/```(?:json)?\s*([\s\S]*?)```/) || output.match(/(\{[\s\S]*\})/);
      const json = JSON.parse(match ? match[1].trim() : '{}');
      return json.workspaceValue === 'acme/specific-repo';
````

## Production Sync

The eval suite automatically imports the production model and prompt:

- **Provider**: Controlled by `ROUTER_EVAL_PROVIDER` and related eval env vars
- **Prompt**: Extracted from `src/server/router/prompts/routing-prompt.ts` (`ROUTING_PROMPT`)

Runtime routing uses the deployment model env vars. The eval suite is still
useful for prompt and dataset regression testing, but its provider is
intentionally configured separately.

## Tips

1. **Start small**: Comment out most datasets when iterating on a specific test
2. **Use `--filter-description`**: Quick way to run a single test by name
3. **Check the web UI**: Much easier to debug failures than terminal output
4. **Watch confidence scores**: Low confidence on clear tasks may indicate prompt issues
5. **Run before deploying**: Catch regressions in routing logic early
