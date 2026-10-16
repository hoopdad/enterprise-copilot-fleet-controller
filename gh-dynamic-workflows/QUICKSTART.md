# Quickstart: deliver a specification to an existing test target

Use **PowerShell 7**, **Node.js 22+**, and a current **Copilot CLI** with
experimental workflows available and an authenticated, eligible account.
There is no `npm install` step: Copilot supplies the extension SDK.

Bring a **different, existing Node project**, a real specification in that repo,
working toolchain/dependencies and baseline/test/build commands, and a named,
existing **nonproduction** target with scoped credentials already configured.
Make its deployment mechanism and endpoint discoverable in repository instructions;
never put credentials in the spec or input. This is not a universal one-command
app generator or infrastructure provisioner. Use a disposable branch or worktree.

## 1. Clone the framework

Run from the parent folder where you keep source repositories:

```powershell
git clone --branch feature/gh-dynamic-workflows --single-branch https://github.com/hoopdad/enterprise-copilot-fleet-controller.git
Set-Location .\enterprise-copilot-fleet-controller
node --version
copilot --version
copilot login
```

If already authenticated, skip `copilot login`. Keep this PowerShell session open.
This selects the feature branch containing the workflow before it is merged.
All distributable files are under `gh-dynamic-workflows`; cloning alone does not
register the extension in the framework repository.

## 2. Install once and create your input

Paste the block below and answer the prompts with real values. The spec path is
relative to the **target project**, not this clone (for example, `specs/product.md`).
The installer refuses existing files: **do not install into this framework clone
or repeat installation over an installed copy**.

```powershell
$framework = (Get-Location).Path
$target = (Resolve-Path -LiteralPath (Read-Host 'Existing product repository folder')).Path
if ($target -eq $framework) { throw 'Select a different existing project.' }
$spec = (Read-Host 'Existing repo-relative product specification file').Replace('\', '/')
if ([IO.Path]::IsPathRooted($spec) -or '..' -in $spec.Split('/')) {
    throw 'Use a repository-relative specification path without .. segments.'
}
if (-not (Test-Path -LiteralPath (Join-Path $target $spec) -PathType Leaf)) {
    throw 'The specification file must already exist in the target project.'
}
$testTarget = Read-Host 'Named existing NONPRODUCTION deployment target'
if ([string]::IsNullOrWhiteSpace($testTarget)) { throw 'A test target is required.' }
$inputFile = Join-Path $target 'delivery-input.json'
if (Test-Path -LiteralPath $inputFile) { throw 'Review the existing delivery-input.json first.' }
node .\gh-dynamic-workflows\install.mjs $target
if ($LASTEXITCODE) { throw 'Installation failed; stop here.' }
$delivery = Get-Content -Raw .\gh-dynamic-workflows\examples\product.json | ConvertFrom-Json
$delivery.projectRoot = '.'
$delivery.input.path = $spec
$delivery.deployment.target = $testTarget
$delivery | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $inputFile
Set-Location -LiteralPath $target
```

Installation places runtime files in the target's `gh-dynamic-workflows`, its
loader in `.github\extensions\autonomous-delivery`, and its read/search-only
agent in `.github\agents`. Review those files before trusting the project.

## 3. Review the input and establish narrow permissions

```powershell
notepad .\delivery-input.json
```

Adapt the goal and acceptance criteria to your spec. The example requires
**`node --test`** for baseline/test and **`node scripts/build.mjs`** for build;
these must be real, passing project commands, not placeholders. Review/adapt
`commands` (native executables and argument arrays; no shell, `npm.cmd`, or
`.bat`), `scope` (`src`, `test`, `scripts/delivery`), and `generatedPaths` (`dist`)
to your project. Run your reviewed baseline/test/build commands successfully
before continuing. Keep `scripts/delivery` writable for generated deployment
adapters, or explicitly configure another scoped `deployment.adapterPaths`.

Review `deployment.acceptance`, `allowedExecutables` (default `node`), and the
named target. You **do not need to author deployment scripts**: the workflow
prepares and reviews deploy/revision-verification/smoke/reconciliation adapters.
It needs an existing, discoverable deployment mechanism and working credentials.
Review both execution/deployment authorization and diagnostics sharing in the
input; saving `authorized: true` is your authorization for this run's commands
and target, not a request for approval before every action. Do not authorize
diagnostics from commands that can print sensitive data.

Add `.delivery-runs/` to your target's `.gitignore`; records stay local. Then:

```powershell
copilot --experimental
```

Complete initial project trust setup. Ask Copilot to reload extensions and list
registered workflows; confirm `autonomous-delivery` loads. An interactive pilot
may be needed to establish narrowly scoped agent read/search permissions for the
spec and project. Exit the session when ready. The terminal runner below **cannot
prompt for unapproved reads**; do not grant blanket permissions to bypass this.

## 4. Run from the target project

```powershell
copilot --experimental workflow run autonomous-delivery --args '@delivery-input.json'
```

Normal delivery is **implement → test/build → deploy → verify → smoke**, without
a routine pause. Check the returned delivery status and `.delivery-runs` records:
`blocked`/`failed` is not success, even if the workflow envelope says `completed`.
Missing tools, permissions, credentials, or verification evidence must block.
For local-only work, explicitly set `deployment` to `{"mode":"build-only"}`.
See [README.md](README.md#delivery-and-resume) for retries, resume, and limitations.
