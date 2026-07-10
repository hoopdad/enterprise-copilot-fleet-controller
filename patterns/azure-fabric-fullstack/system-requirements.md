# Jet Set Bank Demo

## Assumptions (already provisioned by the runtime - do not block on these)

- `az login` and `gh auth` are complete, with rights to create resources and repositories in
  the target Azure tenant and the `hoopdad` GitHub owner.
- Build/runtime tooling is installed: Azure CLI, Azure Developer CLI (`azd`), Terraform, GitHub
  CLI, Git, Docker, Python, Node.js, and the language/lint/test tools needed by each stack.
- A platform hub network already exists for private connectivity and Private DNS linkage.
  Private DNS zones belong in the hub and are linked to workload VNets from there.
- The existing hub, VPN, DNS resolver, and private connectivity model are available. Do not
  create a new hub and do not modify VPN settings.
- Outbound access needed for Azure control plane, container image pulls, model deployment,
  Microsoft Fabric APIs, Azure AI Document Intelligence, Azure AI Foundry Agent Service, and
  package registries is permitted by the operator environment.
- Microsoft Fabric tenant access and permission to provision/use the target capacity/workspace are
  available. Capacity/workspace creation is owned by the infra/fabric deployment split described
  below. Power BI SaaS access is not assumed and must not be required for the first build.

## 1.1 Mission / Outcome

Build and deploy **Jet Set Bank Demo**, a private-first Microsoft Fabric + Azure AI Foundry
multi-agent demonstration for **commercial real estate (CRE) loan document gathering, review,
approval routing, and closing readiness**.

Success means the application is fully deployed in Azure, reachable only through an internal
private application path, and demonstrates a realistic CRE closing workflow for both **banking
executives** and **technical architects/builders**. The demo should answer:

- Can this CRE loan package close?
- What documents or data are missing, stale, mismatched, or policy-exceptional?
- Which agent found each issue, what evidence supports it, and what policy/checklist rule applies?
- What human decision was made, and where is the audit trail?

The target readiness states are:

- **Ready to Close**
- **Ready with Exceptions**
- **Not Ready**

The highlighted guided demo package must resolve to **Ready with Exceptions** so the demo
showcases controlled exception approval, accept-risk reasoning, citations, delegated authority,
and Fabric-backed audit. The executive value narrative must emphasize reduced closing cycle time,
fewer manual document touches, faster readiness decisions, exception-aging reduction, dollar-
weighted visibility, and stronger audit evidence.

This is an `azure-fabric-fullstack` solution: a web front end, a REST API, hosted multi-agent
workflows, Microsoft Fabric/OneLake data assets, Azure AI Document Intelligence extraction,
Terraform infrastructure, and an internal WAF - delivered as a multi-repo fleet coordinated by a
harness.

## 1.2 Repositories

Create these private repositories under owner `hoopdad`. The harness is the parent/orchestrator.
Each child repo is owned by a specialist agent that designs and builds its domain.

| Repo | Role | Responsibility |
|------|------|----------------|
| `jetset-bank-demo-harness` | orchestrator | Coordinates the fleet, owns cross-service contracts, local `azd` deployment flow, demo seed orchestration, validation, and end-to-end tests. |
| `jetset-bank-demo-web` | frontend | React/TypeScript SPA for borrower upload, closing coordinator workbench, policy admin, simulated Power BI-style executive dashboard, agent findings review, and Jet Set Bank branding. |
| `jetset-bank-demo-api` | backend | Python/FastAPI API for local demo auth, document upload orchestration, OneLake/Fabric access, Document Intelligence job coordination, agent invocation, workflow state, health, and version endpoints. |
| `jetset-bank-demo-agents` | agents | Python agents built with Microsoft Agent Framework and deployed to Azure AI Foundry Agent Service. |
| `jetset-bank-demo-fabric` | fabric/data | Fabric workspace assets: OneLake landing structure, Lakehouse/Warehouse tables, event/work-queue tables, policies/checklists, notebooks/pipelines/UDFs, semantic model, and seed data. |
| `jetset-bank-demo-infra` | infrastructure | Terraform-only Azure infrastructure using `hoopdad/mcaps-infra-skills`, including networking, ACA, WAF, Foundry, Document Intelligence, Fabric connectivity, identities, RBAC, diagnostics, and private endpoints. |
| `jetset-bank-demo-waf` | waf | Internal-only ACA-hosted nginx/ModSecurity WAF with OWASP Core Rule Set, private frontend path, and internal routing to web/API backends. |

## 1.3 Demo Storyline

Jet Set Bank is preparing a $4.8M CRE loan package for closing. The borrower uploads documents
through the portal. Fabric stores the raw documents and structured workflow state. Azure AI
Document Intelligence extracts fields. Deterministic check tools establish stable evidence for
known demo issues. Foundry-hosted agents review completeness, document quality, credit policy,
compliance checks, approval routing, and audit evidence.

The package intentionally includes issues:

- missing guarantor signature
- expired insurance certificate
- stale appraisal
- borrower legal-name mismatch
- DSCR policy exception

The closing coordinator sees asynchronous agent status, reviews cited findings, requests borrower
remediation for items that must be fixed, and approves controlled exceptions/accepts risk under
delegated authority with a required reason. The package lands at **Ready with Exceptions**, and
Fabric stores the full source-backed audit trail.

The landing page should use slightly cheesy Jet Set Bank marketing language riffing on "jetset"
while staying credible for a banking demo. Example tone: "Put your CRE closings on final approach"
or "Board faster with an AI-assisted closing room."

## 1.4 User Experience & Workflow Requirements

### Personas

Only two personas are interactive in the first build:

- **Borrower** - uploads requested documents, sees missing/requested items, and responds to
  remediation requests inside the portal.
- **Closing Coordinator** - monitors packages, reviews agent findings, requests remediation,
  accepts or rejects recommendations, submits approvals, and determines closing readiness.

Credit analyst, compliance reviewer, approval router, closing coordinator assistant, and audit
functions are represented by agents rather than separate human user personas.

### Authentication

- Use simple/local demo authentication for borrower and closing coordinator personas.
- Do not require Entra ID or Entra External ID for interactive borrower/coordinator sign-in in
  the first build.
- Azure service authentication still uses managed identities, service principals where required,
  and Entra RBAC for Azure resources, Fabric, Foundry, Key Vault, ACR, and Document Intelligence.
- Do not require Microsoft 365, SharePoint, OneDrive, email, or Teams licensing for the first
  build.
- Keep the design compatible with a future Entra-based authentication upgrade, but do not build it
  unless a later requirement explicitly changes this scope.

### Borrower portal

- Borrower can view requested document checklist items for a package.
- Borrower can upload documents through the web portal.
- Borrower can download or access a generated sample document bundle for repeatable demos.
- Borrower can see portal-only remediation requests.
- Borrower can resubmit documents for remediation.
- Do not send or simulate outbound email for borrower notifications in the first build.

### Closing coordinator workbench

- Show the 10-package CRE portfolio with the guided demo package highlighted.
- Show per-package readiness state, document status, exception count, and agent workflow status.
- For a selected package, show:
  - uploaded documents
  - extraction status
  - extracted fields
  - policy/checklist checks
  - agent findings
  - severity and readiness impact
  - citations to source document/page/field and policy/checklist row
  - remediation actions
  - approval routing recommendation
  - audit timeline
- Coordinator can accept, reject, or request remediation on agent recommendations.
- Coordinator can approve a controlled exception or accept risk on an agent finding only within
  delegated authority and only by entering a required reason/comment.
- Controlled exception approval and accept-risk decisions must be stored in the Fabric audit
  trail.
- A package cannot move to **Ready to Close** unless required human review gates are satisfied.

### Policy admin

- Include a lightweight policy/admin page in the React app.
- The page edits seeded CRE checklist and policy rows stored in Fabric.
- Required first-build editable fields:
  - enabled/disabled
  - required/not required
  - threshold value
  - severity
  - readiness impact
  - policy/check description
- Saving a policy change writes to Fabric, creates an audit entry, and triggers affected agent
  checks through the event-driven workflow.
- Agents must read and cite Fabric policy/checklist rows rather than relying on hard-coded rules.

### Simulated Power BI-style dashboards

Power BI SaaS access must not be required. The React app must simulate a Power BI-style executive
experience backed by Fabric Lakehouse/Warehouse tables and a Power BI-ready semantic model.

Include two views:

- **Executive portfolio view**
  - Shows 10 sample CRE loan packages.
  - Highlights the main guided demo package.
  - Includes varied statuses: Ready to Close, Ready with Exceptions, Not Ready, In Review, and
    Awaiting Borrower Documents.
  - Shows KPI cards, readiness funnel, exception breakdown, document aging, package status, agent
    finding severity, and drill-through views.
  - Shows dollar-weighted exposure, exception aging, SLA bottlenecks, manual-touch reduction, and
    loans at risk of missing target close date.
- **Closing coordinator workbench view**
  - Focuses on active package processing, agent progress, exception review, remediation, approval
    routing, and audit evidence.

## 1.5 Demo Data Requirements

The first build must include generated, synthetic, demo-safe data only.

### Portfolio

- Generate or seed 10 CRE loan packages.
- Main highlighted package resolves to **Ready with Exceptions**.
- Other packages cover the full status range:
  - Ready to Close
  - Ready with Exceptions
  - Not Ready
  - In Review
  - Awaiting Borrower Documents

### Core CRE document set

The first-build checklist focuses on:

- loan application
- rent roll
- operating statement
- appraisal
- insurance certificate
- entity documents
- guaranty
- environmental report
- title commitment
- flood determination

### Intentional findings in the guided package

The guided package must include stable, demo-detectable issues:

- missing guarantor signature
- expired insurance certificate
- stale appraisal
- borrower legal-name mismatch
- DSCR policy exception

Agent wording and confidence can vary because the agents are LLM-backed, but these anchor issues
must remain detectable and repeatable.

## 1.6 Multi-Agent Requirements

Agents must be coded in Python using Microsoft Agent Framework and deployed to Azure AI Foundry
Agent Service.

Authoritative implementation references:

- Microsoft Agent Framework getting started:
  <https://learn.microsoft.com/en-us/agent-framework/get-started/>
- Azure AI Foundry Agent Service GA:
  <https://devblogs.microsoft.com/foundry/foundry-agent-service-ga/>

### Required agents

| Agent | Responsibility |
|-------|----------------|
| Document Intake Agent | Tracks uploaded documents, expected document types, package completeness, and upload/remediation events. |
| Document Extraction Agent | Coordinates Azure AI Document Intelligence results and normalizes extracted fields into Fabric tables. |
| Completeness Agent | Compares received documents and extracted fields against the CRE checklist. |
| Credit Review Agent | Reviews operating statement, rent roll, DSCR, collateral value, guarantor support, and credit policy checks. |
| Compliance Review Agent | Reviews flood, insurance, appraisal age, entity, environmental, and required disclosure/compliance checks. |
| Approval Routing Agent | Determines approval path based on amount, exception severity, risk status, and delegated authority policy rows. |
| Closing Coordinator Agent | Produces coordinator-facing next actions, borrower remediation text, and closing readiness narrative. |
| Audit Agent | Writes source-backed evidence, recommendations, human decisions, override reasons, and policy citations to Fabric audit tables. |

### Agent behavior

- Agent execution is asynchronous.
- The portal shows per-agent queued/running/complete/failed status.
- Agent findings come from real LLM-backed Foundry Agent execution and may vary slightly across
  runs.
- Stable sample-package issues remain deterministic demo anchors.
- Agents must cite source documents, pages, extracted fields, policy/checklist rows, and human
  decisions where applicable.
- Use GPT-4.1-mini or the lowest-cost equivalent mini-class Foundry model available in Central US
  that supports agent/tool execution.
- Agents must not autonomously approve a loan. They recommend, route, explain, and audit; humans
  approve controlled exceptions or accept risk under delegated authority.
- The `jetset-bank-demo-agents` repo owns Python agent definitions, prompts, tool contracts,
  deployment scripts, and deterministic check tools.
- Foundry hosts the agent definitions/model runtime. The API dispatcher invokes Foundry Agent
  Service and writes status/results back to Fabric.
- Each anchor issue must be enforced by a deterministic tool/function that reads ground truth from
  Fabric. The LLM narrates, prioritizes, and explains; it does not decide whether the five anchor
  issues exist.

## 1.7 Fabric, Data, and Eventing Requirements

Microsoft Fabric is the authoritative system for all operational and analytical state in the first
build.

### Storage and tables

- Raw uploaded documents land in OneLake.
- Extracted fields, normalized entities, workflow state, findings, approvals, policy/checklist
  rows, domain events, work queue, and audit evidence live in Fabric Lakehouse/Warehouse tables.
- Do not introduce a separate operational database unless a later requirement explicitly changes
  the pattern.
- The guided package has full source documents and Document Intelligence extraction. The other
  nine portfolio packages may be seeded Fabric records for dashboard realism unless a later
  requirement expands full-document coverage.
- Fabric capacity and workspace ownership must be explicit:
  - `jetset-bank-demo-infra` owns capacity, workspace, private networking/private link, and RBAC
    where Terraform/provider support exists.
  - `jetset-bank-demo-fabric` owns Lakehouse, Warehouse, Eventstream, Activator, semantic model,
    seed data, and Fabric workspace items through Fabric REST/CLI/PowerShell where Terraform
    support is unavailable.
  - Use a minimum F4 Fabric capacity unless current docs or preflight checks require a higher SKU
    for selected Real-Time Intelligence features.

### Required logical tables/entities

- loan packages
- borrowers
- properties/collateral
- document checklist
- uploaded documents
- document extraction jobs
- extracted fields
- policy/checklist rules
- agent work queue
- agent run status
- agent findings
- remediation requests
- human decisions
- approval routing recommendations
- audit events
- portfolio dashboard facts/views

### Event-driven workflow

Prefer Fabric-native event-driven triggers over manual "rerun agents" controls.

Use Microsoft Fabric Real-Time Intelligence eventstreams and Activator where supported for:

- document upload
- Document Intelligence extraction completion
- policy/checklist changes
- coordinator decisions
- borrower remediation submissions

Trigger downstream Fabric pipelines, notebooks, User Data Functions, or business events to enqueue
agent work and update workflow state.

If native change notifications are not available for a specific Fabric artifact, write explicit
domain events and work-queue rows into Fabric as the fallback. The event model must remain
observable and replayable.

The API owns agent dispatch and is the sole caller of Azure AI Foundry Agent Service. Fabric
events and work-queue rows enqueue work. The API dispatcher drains the queue, invokes Foundry
agents, and writes status/results back to Fabric. Fabric must not call Foundry directly in the
first build, preventing duplicate dispatch paths.

## 1.8 Document Intelligence Requirements

- Use Azure AI Document Intelligence to extract fields from uploaded CRE loan documents.
- Use `prebuilt-layout` and `prebuilt-document` as the first-build model set.
- Custom-trained Document Intelligence models are out of scope for the first build.
- Do not rely only on synthetic metadata or manual parsing.
- Store raw extraction output and normalized extracted fields in Fabric.
- Preserve enough extraction metadata to cite:
  - model ID
  - document ID
  - document type
  - page number
  - field name
  - extracted value
  - confidence where available
  - extraction timestamp
- Findings and audit records must link back to source extraction metadata.

## 1.9 Technical Requirements

### Platform and deployment

- Deploy all regional Azure resources to **Central US**.
- Deploy locally from the harness with Azure Developer CLI (`azd`).
- Use a single orchestrated flow for infrastructure and application rollout.
- Deploy in this order: infrastructure -> Fabric workspace/items/seed data -> API -> agents ->
  web -> WAF -> private-path validation.
- Use semantic versioning starting at `0.1.0`.
- Use per-repo semantic versioning. The UI should surface component versions for web/API/agent
  contracts where available.
- Expose health and version endpoints on WAF, web, API, and agent-facing services where applicable.
- Display the application version in the web UI near the Jet Set Bank application name.

### Application stack

- Frontend: React with TypeScript, Vite, Vitest, and Playwright.
- Backend: Python 3.12 with FastAPI and pytest.
- Agents: Python 3.12 with Microsoft Agent Framework and Azure AI Foundry Agent Service.
- WAF: nginx/ModSecurity with OWASP CRS running on Azure Container Apps.
- Infrastructure: Terraform only.

### Azure services

Use these as first-build target services:

- Azure Container Apps
- Azure Container Registry
- Azure Key Vault
- Azure AI Foundry Agent Service
- Azure AI model deployment for GPT-4.1-mini or equivalent mini-class model
- Azure AI Document Intelligence
- Microsoft Fabric
- OneLake
- Fabric Lakehouse/Warehouse
- Fabric Real-Time Intelligence Eventstreams and Activator where supported
- Azure Monitor / Log Analytics
- Private DNS and Private Link/private endpoints where supported

### Preflight checks

The harness must validate before late-stage deployment:

- Central US model availability and quota for GPT-4.1-mini or selected mini-class equivalent
- Azure AI Document Intelligence availability
- Fabric capacity/workspace readiness and required Real-Time Intelligence feature availability
- hub/VPN/private DNS reachability to the spoke and private WAF path
- private endpoint/private link support for selected services
- ACR, Key Vault, ACA, Foundry, and Fabric provider/API limitations

## 1.10 Networking & Internal WAF Requirements

This demo is private-first. The application must not expose a public endpoint.

### Internal WAF language

The WAF is an **internal-only WAF for blast-radius control**. It is not public-facing internet
ingress. It exists to inspect and route approved internal application traffic before traffic reaches
internal ACA services.

### Required model

- Use an internal Azure Container Apps environment.
- Use internal ACA ingress behind the private WAF.
- Deploy the WAF on Azure Container Apps using nginx/ModSecurity with OWASP CRS.
- The WAF is the single private application entry point.
- The WAF has a private IP/private internal access path only.
- Backends are reachable only from inside the workload network path.
- Do not rely on public ACA managed ingress for the application path.
- Publish private DNS for user access only to the WAF entry point.
- Restrict backend ingress to the internal ACA environment/WAF path.
- App/API services must reject direct requests that bypass the WAF by requiring a WAF-injected
  internal header, except for explicitly allowed platform health probes.

### Hub-and-spoke

- Use a spoke VNet for the workload.
- Use appropriately sized subnets for WAF, ACA environment, private endpoints, and support
  services.
- Use zero-trust NSGs with explicit allow rules and deny-by-default posture.
- Use private endpoints/private networking wherever supported for ACR, Key Vault, Foundry,
  Document Intelligence, Fabric/OneLake access paths, monitoring, and supporting data-plane
  surfaces.
- Foundry Agent Service and tool connectivity must be wired for Private Link/private networking
  with hub private DNS integration where supported.
- Unsupported control-plane or SaaS endpoints must be documented as controlled outbound
  exceptions rather than implied private paths.
- Private DNS zones belong in the hub and are linked to every VNet. Do not create Private DNS
  zones in the spoke.
- Do not create a new hub. Do not modify VPN settings.
- Demo users reach the private WAF through the existing hub/VPN/private DNS path. If that route
  is unavailable, demo access is blocked and must be resolved outside this workload.

### WAF upload tuning

- Use OWASP CRS at paranoia level 1 for the first build.
- Do not disable CRS globally.
- Add minimum-necessary, route-specific CRS exclusions for multipart PDF upload endpoints.
- Set a demo-appropriate request body limit, initially 50 MB.
- Include an end-to-end test that uploads the sample document bundle through the WAF.

## 1.11 Identity & Security Requirements

- Use simple/local demo authentication for borrower and coordinator personas.
- Keep future Entra end-user sign-in integration possible, but do not require it for the first
  build.
- Azure service authentication uses managed identity, service principals where required, and
  Entra RBAC.
- Use managed identity for service-to-service and service-to-Azure access wherever possible.
- Use least-privilege RBAC.
- Store unavoidable secrets in Key Vault.
- Do not commit secrets, credentials, keys, `.env` files, or generated sample sensitive data.
- Render user-supplied content safely.
- Restrict CORS to the internal app origin.
- Apply sensible HTTP security headers at the WAF and app layers.
- Validate file uploads for type, size, and expected document handling.
- Do not allow document upload paths to become SSRF, path traversal, or arbitrary file-read/write
  paths.
- Audit agent outputs, human decisions, overrides, policy edits, and readiness transitions.

## 1.12 Infrastructure as Code Requirements

- Use **Terraform only**. Do not use Bicep.
- Use skills from <https://github.com/hoopdad/mcaps-infra-skills>.
- Required infra skill alignment:
  - secure Azure Terraform coding
  - hub discovery/usage
  - spoke provisioning
  - private DNS linkage
  - private endpoint validation
  - defender/security posture where applicable
- Keep reusable modules separate from workload-specific composition.
- The harness owns local `azd` orchestration and deployment ordering.
- The infrastructure repo owns Azure resource definitions and outputs consumed by app repos.
- The harness owns cross-service JSON Schema/OpenAPI contracts for package state, domain events,
  work-queue rows, agent run status, findings, policy rows, human decisions, and audit records.

## 1.13 Quality, Observability, and Operations

- Each service exposes health and version endpoints.
- Containerized services run as non-root, multi-stage containers.
- Services emit structured logs.
- Agent runs, workflow events, policy changes, coordinator decisions, and audit writes are
  traceable by package ID and run ID.
- Before deployment, run the appropriate local gates for each repo:
  - lint
  - unit tests
  - build
  - IaC validation
  - container build
  - container scan where available
  - end-to-end smoke tests
- Validate the private app path through the internal WAF to the web/API services.
- Validate that sample document upload succeeds through the internal WAF without disabling OWASP
  CRS globally.
- Validate that Fabric tables contain uploaded document metadata, extracted fields, agent status,
  findings, decisions, and audit events after the guided demo flow.
- Validate that all five anchor findings are present regardless of LLM wording.

## 1.14 Gaps Closed by Recommendation

No blocking requirements gaps remain for the first build. The following gaps were closed by
recommended defaults:

| Gap | Recommendation Locked |
|-----|------------------------|
| Power BI access | Do not require Power BI SaaS; simulate a Power BI-style dashboard in React backed by Fabric tables. |
| Human personas | Keep borrower and closing coordinator interactive; model other banking roles as agents. |
| Policy storage | Use seeded but editable Fabric policy/checklist tables, not hard-coded rules. |
| Agent reruns | Prefer Fabric event-driven triggers; use explicit Fabric domain events/work-queue rows as fallback. |
| Agent execution | Run asynchronously and show per-agent progress/status in the portal. |
| Package concurrency | Support multiple packages concurrently, with one highlighted guided demo package. |
| Approval blocker | Make the guided package resolve to Ready with Exceptions to showcase governed human accept-risk. |
| Document scope | Use a focused CRE checklist that is realistic but buildable in the first release. |
| Public ingress ambiguity | Use an internal-only WAF for private blast-radius control, not internet ingress. |
| Entra ambiguity | No Entra end-user sign-in for first build; service auth still uses managed identity/Entra RBAC. |
| Fabric ownership | Infra owns capacity/workspace/networking where supported; Fabric repo owns workspace items and seed data. |
| Agent dispatch | API is the sole Foundry caller; Fabric events/work queues enqueue work. |
| LLM determinism | Deterministic tools enforce anchor findings; LLMs explain and prioritize. |
| WAF upload risk | Route-specific CRS tuning and upload E2E tests are required. |

## 1.15 Out of Scope for First Build

- Real borrower data.
- Real M365, SharePoint, OneDrive, Teams, or email integration.
- Power BI SaaS embedding or report publishing.
- Entra ID or Entra External ID end-user sign-in.
- Public internet ingress.
- Full commercial lending system replacement.
- Core banking system integration.
- Production-grade policy management beyond the lightweight admin page.
- Production committee voting or legally binding approval workflow.

## 1.16 Acceptance Criteria

The first build is acceptable when:

- The private multi-repo fleet can be generated for the `azure-fabric-fullstack` pattern.
- The application deploys to Central US with Terraform-only infrastructure and local `azd`
  orchestration.
- The app is reachable only through the internal WAF/private app path.
- The app is reachable from the existing hub/VPN/private DNS path without public ingress.
- Borrower can upload sample CRE documents through the portal.
- Borrower upload succeeds through nginx/ModSecurity OWASP CRS without globally disabling CRS.
- Raw documents land in OneLake.
- Azure AI Document Intelligence extracts fields and stores results in Fabric.
- Fabric stores package state, policy/checklist rows, events/work queue, agent status, findings,
  human decisions, and audit evidence.
- Foundry-hosted Microsoft Agent Framework agents run asynchronously through the API dispatcher
  and update visible portal status.
- The highlighted package surfaces the intended findings and resolves to Ready with Exceptions.
- Coordinator can request remediation, accept/reject findings, and approve a controlled exception
  or accept risk only with a required reason.
- Audit records cite documents/pages/fields, policies/checklist rows, agent findings, human
  decisions, and override reasons.
- The React app includes:
  - Jet Set Bank landing page with light "jetset" marketing riff
  - borrower portal
  - closing coordinator workbench
  - lightweight policy admin page
  - simulated Power BI-style executive portfolio dashboard
- The simulated dashboard shows 10 sample packages with varied statuses.
- Local quality gates and end-to-end smoke tests pass.
