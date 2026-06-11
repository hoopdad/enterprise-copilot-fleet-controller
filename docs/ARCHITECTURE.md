# Architecture: Coordinator + Child Repo Agents + MCP

## Core Design

**Agents communicate through structured YAML contracts and requirements files. Work moves deterministically through child-repo queues: `work/todo → work/ready-for-review → work/done`.**

## Why This Architecture

### Problem
LLM agents degrade with ambiguity and shared context. Cross-repo tasks create confusion about code ownership.

### Solution
1. **Isolated context windows.** Specialists and critics run as separate Copilot invocations from each child repo root.
2. **Structured interfaces as contracts.** `.contracts/*.yml` and `.requirements/*.yml` serve as typed interfaces with mechanical validation.
3. **Native Copilot CLI integration.** Uses `.github/copilot-instructions.md`, `<child>/.github/agents/*.agent.md`, child `work/` queues, and `tools:` frontmatter for MCP scoping.
4. **Separation of judgment from execution.** Orchestrator decides *what* and *why*; specialists decide *how*.
5. **Reviewable checkpoints.** A human can read `.requirements/*.yml` and know exactly what the system will attempt.

## The Governance Chain

```
.github/copilot-instructions.md                  → governs orchestrator
<child>/.github/agents/<name>-specialist.agent.md → governs specialists
<child>/.github/agents/<name>-critic.agent.md     → governs critics
.github/mcp.json                                  → MCP tools (optional)
tools: [...] in each .agent.md                   → restricts tools per agent
```

## The Flow

```
Human frames problem (natural language)
  ↓
Orchestrator structures it (YAML requirements + contracts)
  ↓
Orchestrator writes per-repo requests in child work/todo/
  ↓
Specialist executes in child repo, moves to work/ready-for-review/
  ↓
Critic evaluates against requirements/contracts (STATUS: PASS|FAIL)
  ↓
FAIL → returns to work/todo/; PASS → moves to work/done/
  ↓
Orchestrator verifies acceptance criteria from done queue
  ↓
Human reviews result
```

Every arrow narrows scope. Every file is a checkpoint where a human can intervene.
