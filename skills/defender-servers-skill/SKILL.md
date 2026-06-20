---
name: defender-servers-skill
description: Enable Microsoft Defender for Servers Plan 2 at the Azure subscription level using Terraform. Use when the user needs to remediate the "Enable Microsoft Defender for Servers" security control, enable Defender for Servers, set the VirtualMachines pricing tier to Standard/P2, or satisfy MDC compliance for server protection.
---

# Microsoft Defender for Servers Skill

## Purpose

Use this skill to generate Terraform that enables Microsoft Defender for Servers **Plan 2 (P2)**
at the Azure subscription scope — the required configuration to pass the
_Enable Microsoft Defender for Servers_ compliance control.

Expected outcomes:

- Create `main.tf` with an `azurerm_security_center_subscription_pricing` resource targeting the
  `VirtualMachines` resource type, `Standard` tier, and `P2` subplan.
- Create `providers.tf`, `variables.tf`, `outputs.tf`, and `README.md`.
- Run `terraform fmt -recursive`, `terraform init`, and `terraform validate`.

## Invoke When

Use this skill when the user asks to:

- enable Microsoft Defender for Servers
- remediate the "Enable Microsoft Defender for Servers" control
- set Defender for Servers to Plan 2 / P2
- satisfy MDC / Microsoft Defender for Cloud compliance for virtual machines
- enable `VirtualMachines` pricing tier in Microsoft Defender for Cloud

## Control Requirements

To pass this control:

- Microsoft Defender for Servers must be enabled **at the subscription level**.
- The plan must be set to **Plan 2 (P2)** (`pricingTier: Standard`, `subPlan: P2`).

Equivalent Bicep reference (for context only — this skill generates Terraform):

```bicep
targetScope = 'subscription'

resource defenderForServers 'Microsoft.Security/pricings@2024-01-01' = {
  name: 'VirtualMachines'
  properties: {
    pricingTier: 'Standard'
    subPlan: 'P2'
  }
}
```

## Inputs

Prefer existing `TF_VAR_*` environment variables. Ask only for missing values.

If the user needs a starter tfvars file, use:

- [templates/terraform.tfvars.template](templates/terraform.tfvars.template)

Required values:

- `TF_VAR_subscription_id` — the target Azure subscription ID

Optional values:

- Custom output directory (default: `./defender-servers/`)

## Files To Generate

Write these to `./defender-servers/` by default unless the user overrides the directory:

- `providers.tf`
- `variables.tf`
- `main.tf`
- `outputs.tf`
- `README.md`

## Terraform Requirements

Generated Terraform must:

- require Terraform `>= 1.9`
- use `azurerm` `~> 4.50`
- configure the `azurerm` provider with `subscription_id` from a variable and CLI auth
  (`use_cli = true`)
- scope the `azurerm_security_center_subscription_pricing` resource to the subscription

### `providers.tf`

```hcl
terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.50"
    }
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id
  features {}
}
```

### `variables.tf`

```hcl
variable "subscription_id" {
  description = "The Azure subscription ID where Defender for Servers will be enabled."
  type        = string
}
```

### `main.tf`

Generate this with descriptive comments so users understand the import workflow:

```hcl
# Microsoft Defender for Servers — Plan 2 (P2)
# 
# If this subscription already has Defender enabled, terraform plan/apply will fail with:
#   "already exists - to be managed via Terraform this resource needs to be imported"
# 
# Solution: Run this BEFORE terraform apply:
#   terraform import azurerm_security_center_subscription_pricing.defender_for_servers \
#     /subscriptions/{subscription_id}/providers/Microsoft.Security/pricings/VirtualMachines
#
# Then proceed: terraform plan -> terraform apply

resource "azurerm_security_center_subscription_pricing" "defender_for_servers" {
  tier          = "Standard"
  resource_type = "VirtualMachines"
  subplan       = "P2"
}
```

### `outputs.tf`

```hcl
output "defender_for_servers_id" {
  description = "The resource ID of the Defender for Servers pricing configuration."
  value       = azurerm_security_center_subscription_pricing.defender_for_servers.id
}
```

### `README.md`

Include:

- Purpose: enable Defender for Servers Plan 2 at subscription scope.
- Prerequisites: Azure CLI authenticated, `subscription_id` set.
- Usage: `terraform init`, `terraform plan`, `terraform apply`.
- Compliance note: satisfies the _Enable Microsoft Defender for Servers_ control (Plan 2 / P2).

## Execution Rules

1. Read all available `TF_VAR_*` values first.
2. Ask once for only the missing required inputs.
3. Do not hard-code subscription IDs in generated `.tf` files — always use `var.subscription_id`.
4. Generate `main.tf` **with descriptive comments** explaining the import workflow (see template above).
5. Write files to disk.
6. **Pre-flight check:** Run `terraform init`, then `terraform plan`:
   - If plan shows **no changes** ✅ Defender for Servers is already at P2 on this subscription → no apply needed.
   - If plan shows **1 to create** or **update** ✅ Safe to apply.
   - If plan fails with **"already exists - to be managed via Terraform"** ⚠️ Follow steps in generated `main.tf` comments:
     - Run `terraform import azurerm_security_center_subscription_pricing.defender_for_servers /subscriptions/{id}/providers/Microsoft.Security/pricings/VirtualMachines`
     - Then re-run `terraform plan`
7. Run `terraform fmt -recursive`, `terraform init`, and `terraform validate`.
8. Do not run `terraform apply` — let user review plan and run it manually.

### Common Issues

**Error: `resource address "azurerm_security_center_subscription_pricing.defender_for_servers" does not exist in the configuration`**

This means the resource block is missing from `main.tf`. Check:
1. Verify `main.tf` exists in the `defender-servers/` directory
2. Verify it contains the `resource "azurerm_security_center_subscription_pricing"` block
3. If missing, regenerate files using the skill
4. Then retry the import command


## Final Response

End with:

- the files written
- the results of `terraform fmt`, `terraform init`, and `terraform validate`
- any missing values still required from the user
- **pre-flight plan output** (run `terraform plan -out=tfplan` and show results)
- clear guidance:
  - If **no changes** → resource already at P2, no apply needed
  - If **would create** + error about existing resource → follow [Import Existing](#import-existing) steps
  - If **would update** → safe to apply with `terraform apply tfplan`
- next steps for `terraform apply` (if needed) or verification in Azure Portal
