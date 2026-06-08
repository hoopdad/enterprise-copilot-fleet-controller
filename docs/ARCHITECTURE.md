# Architecture: Coordinator + Child Repo Agents + MCP

## The Thesis

This framework's core design decision: **agents communicate through structured YAML contracts and requirements files, while work moves deterministically through child-repo queues (`work/todo → work/ready-for-review → work/done`).**

This is not an implementation detail — it is the product.

## Why This Architecture (v2.9.0)

### Problem: LLM agents degrade with ambiguity and shared context

When agents share a single context window, they pollute each other's reasoning. Cross-repo tasks create confusion about which code belongs where. Natural language handoffs between agents are lossy.

### Solution: Coordinator protocol + child repo specialists/critics + structured interfaces

1. **Isolated context windows.** Specialists and critics run as separate Copilot invocations from each child repo root. No cross-contamination.

2. **Structured interfaces as contracts.** `.contracts/*.yml` and `.requirements/*.yml` serve as typed interfaces. If a specialist implements something that doesn't match the contract shape, the `contract-compliance` tool catches it mechanically.

3. **Native Copilot CLI integration.** Instead of custom routing or agent orchestration code, we use what's built into the platform:
   - `.copilot/instructions.md` → orchestrator behavior
   - `<child>/.github/agents/*.agent.md` → specialist/critic behavior
   - child `work/` queues → deterministic handoff state
   - `tools:` frontmatter → scopes MCP tools per specialist/critic

4. **Separation of judgment from execution.** The orchestrator decides *what* to build and *why*. Specialists decide *how*. This mirrors effective human teams.

5. **Reviewable checkpoints.** A human can read `.requirements/*.yml` and know exactly what the system will attempt. No need to parse LLM conversations.

### Why not a routing table / agent mesh?

Agent routing systems (LangChain, CrewAI, AutoGen) add infrastructure between agents. This framework adds *nothing* between agents — just files in git plus the platform's native fleet mechanism. 

Benefits:
- Zero runtime dependencies beyond git + Copilot CLI
- Full audit trail for free (git log)
- Human-readable at every stage
- Works with Copilot CLI's built-in model routing
- No custom orchestration code to maintain

### Why append-only decisions?

`.decisions/log.md` is append-only because:
- It prevents decision amnesia (agent re-litigates a settled question)
- It's cheap to scan (one line per decision)
- It creates institutional memory that transfers between sessions

### Why deterministic templates for empty repos?

v1.x used LLM calls during `init.sh` to generate agent definitions. This was fragile — the LLM could hallucinate commands, invent nonexistent tools, or produce structurally invalid files. v2.1.0 uses deterministic templates for empty repos (fast, predictable) and LLM generation with validation for repos with existing code (adaptive, but checked).

### Why red-team as a step, not a separate agent?

The red-team review is a *cognitive mode*, not a separate entity. Having the orchestrator adversarially critique its own output:
- Catches obvious flaws before delegation (cheaper than rework)
- Doesn't require another agent roundtrip
- Forces the orchestrator to think about failure modes *before* committing to a plan

## The Governance Chain

```
.copilot/instructions.md               → governs the orchestrator (main agent)
<child>/.github/agents/<name>-specialist.agent.md → governs each specialist subagent
<child>/.github/agents/<name>-critic.agent.md     → governs each critic subagent
.copilot/mcp.json                       → MCP tools available to all (optional, enable_mcp=true)
tools: [...] in each .agent.md          → restricts which tools each specialist sees
```

## The Flow

```
Human frames the problem (natural language)
  → Orchestrator structures it (YAML requirements + contracts)
    → Orchestrator writes per-repo request files in child `work/todo/`
      → Specialist executes in child repo and moves request to `work/ready-for-review/`
        → Critic evaluates against requirements/contracts (`STATUS: PASS|FAIL`)
          → FAIL returns request to `work/todo/`; PASS moves request to `work/done/`
            → Orchestrator verifies acceptance criteria from done queue
              → Human reviews the result
```

Every arrow is a narrowing of scope. Every file is a checkpoint where a human can intervene. This is the architecture.
