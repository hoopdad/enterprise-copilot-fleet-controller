---
name: hub-skill
description: Scaffold an Azure hub network foundation with AVM-first Terraform, including hub VNets, private DNS, DNS resolver, LAW, AMPLS, and optional VPN or Linux firewall components. Use when the user asks to create a hub network or central networking baseline.
---

# MCAPS Hub Skill

## Purpose

Use this skill to scaffold a production Azure hub foundation with Terraform.

Expected outcomes:

- Create the hub resource group, VNet topology, subnets, and NSGs.
- Create private DNS zones and links.
- Create a private DNS resolver and inbound endpoint.
- Create a Log Analytics workspace and AMPLS.
- Optionally add VPN or Linux firewall components when explicitly requested.

Prefer Azure Verified Modules where available:

- `Azure/avm-res-network-virtualnetwork/azurerm`
- `Azure/avm-res-network-private-dns-zone/azurerm`
- `Azure/avm-res-network-private-dns-resolver/azurerm`
- `Azure/avm-res-monitor-private-link-scope/azurerm`

Use base `azurerm` resources only where no suitable AVM exists.

## Invoke When

Use this skill when the user asks to:

- create or scaffold a hub network
- build a hub module for hub-and-spoke networking
- add DNS resolver, private DNS, LAW, AMPLS, VPN, or NVA to a hub
- set up a central Azure networking baseline using Terraform

## Inputs

Prefer environment variables first. If values are missing, use
[templates/terraform.tfvars.template](templates/terraform.tfvars.template) as the starting point.

Required values:

- `TF_VAR_hub_subscription_id`
- `TF_VAR_hub_resource_group_name`
- `TF_VAR_hub_region`
- `TF_VAR_hub_vnet_name`
- `TF_VAR_hub_law_name`
- `TF_VAR_dns_resolver_name`
- `TF_VAR_lab_prefix`

Optional values:

- `TF_VAR_hub_resource_group_region`
- `TF_VAR_private_dns_zones`
- `TF_VAR_vpn_client_address_pool`
- `TF_VAR_lab_admin_object_id`
- `TF_VAR_vpn_gateway_alert_email_receivers`

Never hard-code subscription IDs in generated `.tf` files.

## Feature Gates

Always include by default:

- hub resource group
- hub VNet and subnets
- private DNS zones and VNet links
- private DNS resolver and inbound endpoint
- Log Analytics workspace
- AMPLS and private connectivity
- core diagnostics settings

Only include when explicitly requested:

- `vpn.tf` and VPN alerts for `S2S VPN` or `P2S VPN`
- `linux-fw.tf` and related UDR patterns for Linux-based firewall or NVA scenarios

## Files To Generate

Write these to `./hub/` by default unless the user overrides the directory:

- `providers.tf`
- `variables.tf`
- `terraform.tfvars` or `terraform.tfvars.template`
- `data.tf`
- `vnet.tf`
- `dns.tf`
- `law.tf`
- `ampls.tf`
- `monitoring.tf`
- `outputs.tf`
- `vpn.tf` when requested
- `linux-fw.tf` when requested
- `README.md`

No nested Terraform submodules are required. Source AVM modules directly from the registry.

## Terraform Requirements

Generated Terraform must:

- require Terraform `>= 1.9`
- use `azurerm` `~> 4.50`
- use `random` `~> 3.5` when needed
- configure `azurerm` with CLI auth
- keep subscription IDs supplied through variables or environment variables

## Execution Rules

1. Read all available `TF_VAR_*` values first.
2. Ask once for only the missing required inputs.
3. Generate provider configuration that supports both AVM modules and fallback `azurerm` resources.
4. Write Terraform files to disk.
5. Run `terraform fmt -recursive`, `terraform init`, and `terraform validate`.
6. Do not run `terraform plan` or `terraform apply`.

## Final Response

End with:

- the files written
- any optional features included or omitted
- any missing values still required from the user
- the results of `terraform fmt`, `terraform init`, and `terraform validate`
- the next steps for `terraform plan` and `terraform apply`