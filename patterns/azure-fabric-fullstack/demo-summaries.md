# Jet Set Bank Demo Summaries

## Elevator Pitch

Jet Set Bank Demo is a Microsoft Fabric and Azure AI Foundry multi-agent banking showcase for
commercial real estate loan closings. Borrowers upload CRE documents, Azure AI Document
Intelligence extracts key fields, Fabric becomes the governed system of record, and Foundry-hosted
agents review completeness, credit, compliance, routing, and audit evidence. A closing coordinator
keeps the human approval gate, while a Power BI-style React dashboard gives executives a portfolio
view of dollar-weighted exposure, readiness, exception aging, risk, SLA bottlenecks, and
operational drag.

In short: **Jet Set Bank puts CRE closings on final approach - faster document review, clearer
exceptions, and an evidence-backed audit trail without pretending agents approve loans on their own.**

## High-Level Feature Summary

Jet Set Bank Demo is a private-first CRE loan closing room with two human personas and a fleet of
specialized agents.

- **Borrower portal** - upload requested CRE documents, see missing items, and respond to
  remediation requests in the portal.
- **Closing coordinator workbench** - monitor package status, agent progress, findings, exceptions,
  remediation, approval routing, and closing readiness.
- **Multi-agent review** - Document Intake, Extraction, Completeness, Credit Review, Compliance
  Review, Approval Routing, Closing Coordinator, and Audit agents operate asynchronously.
- **Fabric-centered data plane** - OneLake stores raw documents; Fabric tables store extraction
  results, workflow state, policy/checklist rows, findings, decisions, and audit evidence.
- **Document Intelligence extraction** - uploaded CRE PDFs are processed with Azure AI Document
  Intelligence, preserving source/page/field citations.
- **Power BI-style dashboard simulation** - React dashboard provides executive portfolio and
  coordinator workbench views without requiring Power BI SaaS access.
- **Human-in-the-loop governance** - agent recommendations require coordinator action; controlled
  exception approvals and accept-risk decisions require reason/comment and are written to Fabric
  audit tables.
- **Private internal WAF** - ACA-hosted nginx/ModSecurity OWASP CRS WAF controls internal blast
  radius and routes private app traffic; it is not public ingress.
- **Terraform + azd fleet delivery** - private multi-repo fleet, Terraform-only infrastructure, and
  local `azd` orchestration.

## Capability Features by Product

| Product / Platform | Demo Capabilities |
|--------------------|-------------------|
| **Microsoft Fabric** | Authoritative operational and analytical store; OneLake raw document landing; Lakehouse/Warehouse tables for package state, extraction output, policy/checklist rules, events, work queue, findings, decisions, and audit evidence; Power BI-ready semantic model; seeded 10-package portfolio. |
| **Fabric Real-Time Intelligence** | Eventstreams and Activator where supported for document upload, extraction completion, policy changes, coordinator decisions, and borrower remediation events; explicit domain-event/work-queue fallback in Fabric. |
| **Azure AI Foundry Agent Service** | Hosted LLM-backed agents for completeness, credit, compliance, approval routing, closing coordination, and audit; private networking/tool connectivity target where supported; mini-class model deployment. |
| **Microsoft Agent Framework** | Python agent workflows, tools, sessions, harness patterns, and multi-step orchestration for agent responsibilities. |
| **Azure AI Document Intelligence** | Extracts structured fields from CRE documents using first-build prebuilt-layout/prebuilt-document models; preserves model/document/page/field/confidence metadata for cited findings and audit records. |
| **Azure Container Apps** | Hosts React web app, Python/FastAPI API, and internal WAF container in an internal ACA environment with private ingress. |
| **nginx/ModSecurity OWASP CRS** | Internal-only WAF tier for HTTP inspection, routing, and blast-radius control before traffic reaches ACA backends. |
| **Azure Container Registry** | Private image registry for web, API, and WAF containers. |
| **Azure Key Vault** | Stores unavoidable secrets; accessed by managed identities and least-privilege RBAC. |
| **Azure Monitor / Log Analytics** | Structured logs, service health, agent workflow traces, audit observability, and deployment diagnostics. |
| **Azure Private Link / Private DNS / Hub-Spoke Networking** | Private-first access paths for application, supporting services, Foundry, Document Intelligence, registry, Key Vault, and Fabric/OneLake where supported; private DNS zones remain in the hub; unsupported SaaS/control-plane paths are documented as controlled outbound exceptions. |
| **Terraform** | All infrastructure as code; no Bicep; uses `hoopdad/mcaps-infra-skills` patterns for secure Azure Terraform, hub/spoke, and private networking. |
| **Azure Developer CLI (`azd`)** | Local harness-driven orchestration for provisioning and deploying the multi-repo fleet. |
| **React/TypeScript** | Jet Set Bank landing page, borrower portal, coordinator workbench, policy admin page, and Power BI-style dashboards. |
| **Python/FastAPI** | API surface for local demo auth, uploads, Fabric/OneLake access, Document Intelligence orchestration, sole Foundry agent dispatch/status path, and health/version endpoints. |

## Executive Narrative

Commercial loan closings often slow down because documents arrive late, data is inconsistent,
policy exceptions are buried in files, and audit evidence is scattered. Jet Set Bank Demo shows how
Fabric and Foundry Agents can create a governed closing room where every document, extracted field,
agent recommendation, human decision, and exception reason is visible and traceable.

The executive value is operational speed with control: fewer manual document chases, clearer
closing readiness, faster exception review, reduced exception aging, dollar-weighted visibility
into at-risk closings, and stronger audit evidence.

## Architect Narrative

The demo is intentionally private-first and buildable: React/TypeScript frontend, Python/FastAPI
API, Python Microsoft Agent Framework agents hosted in Azure AI Foundry Agent Service, Fabric as
the authoritative data plane, Document Intelligence for extraction, event-driven workflow using
Fabric Real-Time Intelligence where available, and Terraform-only infrastructure deployed by local
`azd`.

The design avoids M365, Power BI SaaS, public ingress, and Entra end-user sign-in dependencies for
the first build while preserving clean upgrade paths for each. Azure service authentication still
uses managed identity, service principals where required, and Entra RBAC.
