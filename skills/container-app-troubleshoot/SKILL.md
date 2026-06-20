---
name: container-app-troubleshoot
description: Diagnose and fix Azure Container Apps deployment failures — activation failures, image pull errors, crash loops, health probe failures, and ingress misconfigurations. Use when container apps show "Activation failed", replicas won't start, or deployments aren't healthy.
---

# Container App Troubleshoot Skill

## Purpose

Use this skill to systematically diagnose and remediate Azure Container Apps
deployment failures. It uses the `container-app-diagnostics` MCP tools to gather
evidence, then applies a structured triage process to identify root causes.

## Invoke When

Use this skill when the user mentions any of:

- "Activation failed" on a container app
- Container app not starting / not healthy
- Deployment failed / deploy not working
- Container app crash loop / restarts
- Image pull failure / image not found
- Health probe failure
- Replica not running
- Container app logs / system logs
- "Why is my container app down?"
- Troubleshoot container app
- Debug deployment

## Required MCP Tools

This skill depends on tools from the `container-app-diagnostics` MCP server:

| Tool | Purpose |
|------|---------|
| `diagnose_container_app` | Comprehensive one-shot diagnostic (start here) |
| `get_container_logs` | Pull console or system logs |
| `list_revisions` | See all revisions and their health |
| `check_image_accessibility` | Verify image exists in ACR |
| `compare_container_apps` | Diff working vs failing apps |

It also uses existing tools:

| Tool | Purpose |
|------|---------|
| `inspect_container_app` | Quick status check |
| `deploy_status` | Overview of all services |
| `find_error` | Azure Activity Log errors |

## Triage Protocol

Follow this sequence. Stop at the step that reveals the root cause.

### Step 1: Get the lay of the land

Call `deploy_status` to see all container apps and their running states.
Identify which apps are healthy and which are failing.

### Step 2: Deep-dive the failing app

Call `diagnose_container_app` for each failing app. This single call returns:
- Provisioning and running state
- Revision health and replica status
- Container image, env vars, secrets
- Health probes configuration
- Registry credentials
- Recent system and console logs
- Auto-detected issues list

### Step 3: Interpret the `issues_detected` list

The diagnostic tool returns an `issues_detected` array. Common patterns:

| Issue Pattern | Root Cause | Fix |
|---------------|-----------|-----|
| "Provisioning state is 'Failed'" | Infrastructure problem | Check Terraform state, re-provision |
| "Running state is 'Degraded'" | App crashing or probe failing | Check console logs, health probes |
| "Revision health is 'Unhealthy'" | Container can't start | Check image, env vars, startup command |
| "Container has N restarts" | Crash loop | Check console logs for app errors |
| "Last exit code: 1" | App error at startup | Check console logs, missing env vars |
| "No containers defined" | Bad deployment config | Re-deploy with correct template |

### Step 4: Check image accessibility (if image issues suspected)

Call `check_image_accessibility` to verify:
- The image tag exists in ACR
- Registry credentials are configured
- ACR network access allows pulls

### Step 5: Pull detailed logs

Call `get_container_logs` with `log_type="system"` for platform events:
- Image pull results
- Container start/stop events
- Health probe results
- Scaling decisions

Call `get_container_logs` with `log_type="console"` for application output:
- Startup errors
- Missing configuration
- Runtime exceptions

### Step 6: Compare with working apps

If some apps work and others don't, call `compare_container_apps` to
diff their configurations. Look for differences in:
- Image reference / tag
- Environment variables
- Ingress configuration (port, transport)
- Health probes
- Registry credentials

### Step 7: Check Azure Activity Log

Call `find_error` for the failing resource to see recent Azure platform errors
that may indicate infrastructure-level issues.

## Common Root Causes for __PROJECT_NAME__

### "Activation failed" — WAF

The WAF container listens on port 443 and expects upstream FQDNs as env vars.
Common causes:
1. **Upstream apps not ready**: WAF depends on API, Agent, and Web FQDNs.
   If those apps haven't activated yet, the WAF can't resolve upstreams.
2. **SSL/TLS mismatch**: WAF expects HTTPS upstreams but internal apps may
   not have valid certificates on their internal endpoints.
3. **Port mismatch**: Target port in ingress config must match what nginx
   listens on inside the container.
4. **Image build failure**: The nginx config inside the WAF image may reference
   paths or upstreams that don't exist.

### "Activation failed" — Web

The Web container serves the React SPA on port 80.
Common causes:
1. **Build failure**: The React build may have failed during `az acr build`,
   resulting in a broken image.
2. **Port mismatch**: Ingress target port must be 80 to match nginx/serve.
3. **Missing static files**: If the Dockerfile COPY step failed silently.

### General "Activation failed" causes

1. **Image pull failure**: ACR private endpoint + missing managed identity
2. **Health probe timeout**: Container takes too long to start, probe fails
3. **Missing environment variables**: App crashes at startup due to missing config
4. **Memory/CPU insufficient**: Container OOM-killed during startup
5. **Startup command error**: Dockerfile CMD/ENTRYPOINT is wrong

## Remediation Actions

Once root cause is identified, suggest specific fixes:

- **Re-deploy service**: `bash scripts/azd-deploy.sh` or use `deploy_services_only(service="waf")`
- **Check Dockerfile**: Examine the Dockerfile in the child repo
- **Fix env vars**: Update via `az containerapp update --set-env-vars`
- **Fix ingress**: `az containerapp ingress update --target-port <port>`
- **Rebuild image**: `az acr build --registry <acr> --image <repo>:<tag> <dir>`
- **Check infra**: `azd provision` to ensure infrastructure is correct

## ⚠️ Anti-Pattern: Never Use `sleep` for Deployment Waits

**WRONG** (wastes tokens and wall-clock time):
```bash
sleep 30; az containerapp revision show --name $APP ...
sleep 60; az containerapp revision show --name $APP ...
```

**CORRECT** (poll with timeout):
```bash
TIMEOUT=120; ELAPSED=0; APP="__PROJECT_NAME__-waf"; RG="__RESOURCE_GROUP__"
REV=$(az containerapp show --name $APP -g $RG --query properties.latestRevisionName -o tsv)
while [ $ELAPSED -lt $TIMEOUT ]; do
  STATE=$(az containerapp revision show --name $APP -g $RG --revision $REV \
    --query properties.runningState -o tsv 2>/dev/null || echo "Unknown")
  case "$STATE" in
    Running) echo "✅ $APP running"; break ;;
    Failed)  echo "❌ $APP failed"; break ;;
    *)       sleep 10; ELAPSED=$((ELAPSED + 10)) ;;
  esac
done
[ "$STATE" = "Running" ] || exit 1
```

This saves 3-5 turns per deployment by avoiding repeated "wait and check" cycles.

## Token Efficiency Rules

1. **Consult `.copilot/topology.md` first** — it has all resource names, file paths, and IDs
2. **Never use `find` to locate known files** — paths are documented in topology.md
3. **Batch Azure CLI queries** — combine multiple `--query` fields in one call
4. **Use `--query` and `-o tsv`** — avoid piping full JSON to jq when only one field is needed
5. **One diagnostic call first** — `diagnose_container_app` returns everything; don't call `get_container_logs` + `list_revisions` + `check_image_accessibility` separately unless the one-shot diagnostic is ambiguous

## Output Format

Always present findings as:

1. **Status Summary**: Which apps are healthy, which are failing
2. **Root Cause**: What the diagnostic evidence points to
3. **Evidence**: Specific log lines, error messages, or config mismatches
4. **Fix**: Concrete commands or code changes to resolve the issue
5. **Verify**: How to confirm the fix worked
