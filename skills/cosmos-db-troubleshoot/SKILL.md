---
name: cosmos-db-troubleshoot
description: Read-only Cosmos DB diagnostics for the __PROJECT_NAME__ project. Look up user records by user ID or display name, count documents in any container, and query category config state. Use when data appears missing, stale, or inconsistent — or when verifying persistence after a fix.
---

# Cosmos DB Troubleshoot Skill

## Purpose

Provide read-only diagnostic access to Cosmos DB data for troubleshooting.
Supports looking up user records, counting documents, verifying category
configuration state, and confirming data persistence after deployments.

## Invoke When

- "Is my data in Cosmos?"
- "Look up user by ID"
- "How many documents in container X?"
- "Did categories save?"
- "What's stored for user hoopdad?"
- "Verify persistence"
- "Check Cosmos data"
- "Count records"
- "Query Cosmos DB"
- Data appears missing after container restart
- Need to confirm write-through to Cosmos is working

## Architecture Context

| Property | Value |
|----------|-------|
| Account | __COSMOS_ACCOUNT__ |
| Endpoint | https://__COSMOS_ACCOUNT__.documents.azure.com:443/ |
| Database | __PROJECT_NAME__ |
| Resource Group | __RESOURCE_GROUP__ |
| Auth | Entra RBAC (local keys disabled) |
| Network | Private endpoint only (`public_network_access_enabled = false`) |
| Identity | UAMI `bbfd0671-62b1-4e08-bc85-8db8140a3cac` on container apps |

### Containers

| Container | Partition Key | Typical Document Shape |
|-----------|--------------|------------------------|
| users | /id | `{id, display_name, normalized_name, created_at}` |
| games | /id | `{id, status, players, rounds, scores, started_at}` |
| scores | /userId | `{id, userId, total_points, games_played, last_game}` |
| category_config | /id | `{id, urls, generated_categories, source, updated_at}` |

## Access Method

Since `public_network_access_enabled = false`, Cosmos DB is only reachable from
within the VNet. Use one of these methods:

### Method 1: API Diagnostic Endpoint (Preferred)

If the API has the `/api/admin/cosmos-query` endpoint deployed:

```bash
WAF="https://__PROJECT_NAME__-waf.__ACA_ENV_SUFFIX__.__REGION__.azurecontainerapps.io"
TOKEN="<bearer-token>"

# Count documents in a container
curl -s -H "Authorization: Bearer $TOKEN" \
  "$WAF/api/admin/cosmos-query?container=users&query=SELECT VALUE COUNT(1) FROM c"

# Look up user by display_name
curl -s -H "Authorization: Bearer $TOKEN" \
  "$WAF/api/admin/cosmos-query?container=users&query=SELECT * FROM c WHERE c.display_name = 'hoopdad'"

# Look up user by Entra object ID (the id/partition key)
curl -s -H "Authorization: Bearer $TOKEN" \
  "$WAF/api/admin/cosmos-query?container=users&query=SELECT * FROM c WHERE c.id = 'NOK8o7YK9WJLvGYgy7CYCrZVdwcazIa1PJvaxqewhE'"

# Check category config
curl -s -H "Authorization: Bearer $TOKEN" \
  "$WAF/api/admin/cosmos-query?container=category_config&query=SELECT * FROM c"
```

### Method 2: Container App Exec (Fallback)

If the diagnostic endpoint isn't available, exec into the API container:

```bash
az containerapp exec --name __PROJECT_NAME__-api -g __RESOURCE_GROUP__ \
  --command "python3 -c \"
import asyncio
from azure.cosmos.aio import CosmosClient
from azure.identity.aio import DefaultAzureCredential
import os, json

async def query(container_name, sql):
    cred = DefaultAzureCredential(managed_identity_client_id=os.getenv('AZURE_CLIENT_ID'))
    client = CosmosClient(os.getenv('COSMOS_ENDPOINT'), credential=cred)
    db = client.get_database_client(os.getenv('COSMOS_DATABASE_NAME'))
    container = db.get_container_client(container_name)
    results = [item async for item in container.query_items(sql, enable_cross_partition_query=True)]
    print(json.dumps(results, indent=2, default=str))
    await client.close()
    await cred.close()

asyncio.run(query('users', 'SELECT * FROM c'))
\""
```

### Method 3: Azure Portal Data Explorer

Navigate to:
```
Azure Portal → __COSMOS_ACCOUNT__ → Data Explorer → __PROJECT_NAME__ → <container> → Items
```

## Diagnostic Recipes

### Recipe 1: Verify User Registration Persisted

```
Goal: Confirm user's display_name is stored in Cosmos after registration
Container: users
Query: SELECT * FROM c WHERE c.id = '<entra-object-id>'
Expected: Document with {id, display_name, normalized_name, created_at}
If missing: Registration didn't write to Cosmos (check API logs for errors)
```

### Recipe 2: Count Documents Per Container

```
Goal: Quick health check — are documents being written?
Container: <any>
Query: SELECT VALUE COUNT(1) FROM c
Expected: Non-zero count if data has been persisted
If zero: Persistence layer not working (check API startup logs for Cosmos init errors)
```

### Recipe 3: Verify Category Config Saved

```
Goal: Confirm category URLs were persisted after user saved them
Container: category_config
Query: SELECT * FROM c
Expected: Document with {id: "global", urls: [...], generated_categories: [...]}
If missing: Category save didn't write to Cosmos
If urls empty: Write succeeded but with empty payload (check frontend request body)
```

### Recipe 4: Find User by Display Name

```
Goal: Look up a user's Entra ID from their chosen display name
Container: users
Query: SELECT * FROM c WHERE c.display_name = '<name>'
       OR: SELECT * FROM c WHERE c.normalized_name = '<lowercase-name>'
Expected: Single document with the user's id (Entra object ID)
```

### Recipe 5: Audit All Users

```
Goal: See all registered users and their display names
Container: users
Query: SELECT c.id, c.display_name, c.created_at FROM c ORDER BY c.created_at DESC
Expected: List of all users who have ever registered
```

### Recipe 6: Verify Score Persistence

```
Goal: Confirm game scores are being written
Container: scores
Query: SELECT * FROM c WHERE c.userId = '<entra-object-id>'
Expected: Document with accumulated score data
```

## Troubleshooting Decision Tree

| Symptom | Check | Fix |
|---------|-------|-----|
| Container returns 0 documents | API logs for Cosmos connection errors | Verify COSMOS_ENDPOINT env var, check UAMI role assignment |
| User shows as GUID | Query users container for that GUID | If missing: registration didn't persist; if present: API not reading from Cosmos |
| Categories empty after restart | Query category_config container | If missing: write never happened; if present: API not loading from Cosmos on startup |
| "Forbidden" on Cosmos query | RBAC role missing on identity | Assign `Cosmos DB Built-in Data Contributor` to UAMI on Cosmos account |
| Connection timeout | Private endpoint DNS issue | Check VNet DNS resolution from container; verify private DNS zone link |

## Token Efficiency Rules

1. Use Method 1 (diagnostic endpoint) first — single curl call
2. Use Method 2 (exec) only if endpoint unavailable — slower but always works
3. Batch multiple queries in one exec session when possible
4. Always specify `enable_cross_partition_query=True` for cross-partition queries
5. Use `SELECT VALUE COUNT(1)` not `SELECT COUNT(1)` for scalar counts
6. Check `.copilot/topology.md` for resource names — never use `az cosmosdb list` to discover them

## Output Format

Present findings as:

1. **Query**: What was checked and in which container
2. **Result**: Document count or document contents (redact sensitive fields)
3. **Assessment**: Whether the data matches expected state
4. **Action**: What to do if data is missing or incorrect
