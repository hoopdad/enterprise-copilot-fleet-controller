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

The do-ers research, edit and execute within their original YAML loops, and the
original reviewers decide agreement. There is no mandatory baseline/bootstrap
gate or prebuilt adapter requirement. Review disagreements return to the do-er.
No limits are invented; optionally supply positive `maxSprints` and
`attempts.planning` / `attempts.implementation`.

## Copy/paste installation prompt for GitHub Copilot

> Install the YAML do-er/reviewer workflows from this framework into my existing
> project. Read the target's instructions, preserve unrelated work, and do not
> change an active run. Install the package dependencies and register the two
> workflows without running delivery, deployment or model calls. Use the original
> loops.yml and ordinary do-er/reviewer profiles, not the retired ticket/native
> executor. Keep my actual project permissions. Set up Workflow Studio if wanted
> for design, live and historical observation.

For existing installations, deliberately review/replace the old runtime and
instructions instead of rerunning the non-overwriting installer. Old native
journals are history, not resumable through the new engine. See [README.md](README.md).
