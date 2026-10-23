# PowerShell quickstart

Review the target's actual permissions and project instructions first. This
installs an optional YAML-driven Dynamic Workflow, not generated fleet tooling.

```powershell
# Run from the framework checkout. Target must already exist.
$target = 'C:\path\to\project'
node .\gh-dynamic-workflows\install.mjs $target
if ($LASTEXITCODE) { throw 'Installation failed.' }
npm --prefix "$target\gh-dynamic-workflows" ci
if ($LASTEXITCODE) { throw 'Dependency installation failed.' }
Set-Location -LiteralPath $target
copilot --experimental
```

Trust/reload the reviewed extension in that project and establish ordinary CLI
permissions. Confirm `autonomous-delivery` and `lab-delivery` are registered.
Loading does not execute either workflow.

Create `delivery-input.json`:

```json
{
  "projectRoot": ".",
  "specification": "specs/product.md",
  "acceptance": ["Replace with actual acceptance criteria"],
  "authority": "Describe the real writable repositories, allowed deployment/publication and restrictions"
}
```

Supply an actual specification and authority, then explicitly launch:

```powershell
copilot --experimental workflow run autonomous-delivery --args '@delivery-input.json'
```

Or retain full local logs while showing only the final outcome and stop reason:

```powershell
node .\gh-dynamic-workflows\run.mjs --workflow autonomous-delivery --input delivery-input.json
```

Supply repeated `--add-dir <path>` only for authorized sibling context roots.
`--check-only` reads configuration without starting work. See the README for
non-success exit codes and the unique ignored result/log locations.

Owners research, edit and run commands through ordinary permission-bound tools;
reviewers remain read-only. There is no unrestricted runtime command executor.
Git-tracked `docs/requirements` files and regression tests replace Scrum feedback
triage, Architect advice and Product Owner disposition ledgers. Accepted scope
changes require a committed requirements edit plus a regression test within
existing user authority; declined proposals never enter the ledger. Historical
audits remain readable, not authoritative. No runtime dispositions or governance
are carried forward.

Every role's mandatory correction needs an original user requirement or explicitly
approved amendment citation and a falsifiable failure reason. Demonstrated defects
also need evidence showing how they prevent the requirement. Everything else is
optional, including Architect, Product Owner and Scrum Master suggestions.
Findings use `type:"blocking"|"observation"`, `summary` and `action`; blockers add
`basis:"original-requirement"|"approved-amendment"|"demonstrated-defect"`,
`requirement:{path,line}` and `reason`. Defects also need `evidence`; optional
`failingCheck` must name an emitted failed check with matching evidence.
Cite the original request/approval directly in existing repository-local files;
the positive nonempty line must match committed HEAD without traversal or symlink
escapes. Git verifies integrity, not user authorship or semantic truth.
On retry the owner returns confirmed/refuted/unresolved `correctionAssessments`;
existing reviewers verify that reasoning without adding a new approval stage.
Red Team remains limited to infrastructure configuration and application-library
CVEs (identify CVE/library/version), with required
`scope:"infrastructure-config"|"dependency-cve"`. See LAB-CONTRACT.md for examples.
Owners emit required
`checks:[{id,kind,command,requirement,environment,exitCode,evidence}]`, where kind
is `test`, `schema` or `deployed-probe` and environment is `local` or `deployed`.
Each check's `evidence` is a nonempty repository-relative path to its log/result
file, not arbitrary prose.
The runtime checks readability and repository confinement; reviewers verify
actual execution and credibility.
Complete means nonempty passing checks; assigned work must pass a deployed
check. Reviewers return `checksValid`, `findings`, `feedback` and `workCard`,
not `agree`, to assess suitability and verification. `checksValid:false` alone
cannot block any role. Actual failing/missing execution checks remain binding.

Sprint 1 begins with a dependency-free DevOps `walkingSkeleton:true` assignment
using `azd`; all other assignments depend on it transitively and their `doneWhen`
includes deployed checks. DevOps uses the same graph as other tasks. Existing
DevOps runs after every assignment, then E2E tests that latest deployment before
releasing dependents, not only late in the sprint. All assigned loops acquire
`workflow:deployed-environment` through assignment and verification, serializing
otherwise independent work against the shared environment.
Prepare authorized tools and deployment access;
missing credentials or user-only permissions requires `needs-input`.
The default writing profile is `workflow-owner`, retaining the concrete YAML
role. `agents.owner` overrides it; legacy `agents.doer` still works.
No limits are invented; optionally supply positive `maxSprints` and
`attempts.planning` / `attempts.implementation` as hard caps on all rounds/sprints.
For unlimited productive work, omit those caps and supply
`"maxNoProgressRounds": 10` instead: stop only after ten consecutive rounds
without new progress verified by every original reviewer, or on confirmed
human-input needs. See the README for evidence reporting and the safeguard's
round-boundary limitations. Do not replace an installed runtime during an
active run.

## Copy/paste installation prompt for GitHub Copilot

> Install the YAML do-er/reviewer workflows from this framework into my existing
> project. Read the target's instructions, preserve unrelated work, and do not
> change an active run. Install the package dependencies and register the two
> workflows without running delivery, deployment or model calls. Use the original
> loops.yml and ordinary do-er/reviewer profiles, not the retired ticket/native
> executor. Keep my actual project permissions. Set up Workflow Studio if wanted
> for design, live and historical observation.

The writing profile installed for that original owner role is `workflow-owner`,
not the legacy `workflow-doer`. Existing installed doer profiles can remain for
explicit compatibility overrides. The README's adoption section gives the exact
behavioral copy paths; `install.mjs` is the complete distribution manifest.

For existing installations, deliberately review/replace the old runtime and
instructions instead of rerunning the non-overwriting installer. Old native
journals are history, not resumable through the new engine. See [README.md](README.md).

The current engine is `yaml-loops-v2` with correction contract
`requirement-grounded-v1`. A run marker rejects older v2 contracts and unversioned
history. Preserve old journals as history; they cannot bypass the new correction
rules. Start a fresh run after adoption.
