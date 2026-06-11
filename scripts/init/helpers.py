#!/usr/bin/env python3
"""Shared helper commands for init shell orchestration."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml


def _load_yaml(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def _resolve_path(data: Any, path_expr: str) -> Any:
    if not path_expr or path_expr == ".":
        return data
    node = data
    for part in path_expr.strip(".").split("."):
        if part == "":
            continue
        if isinstance(node, list):
            node = node[int(part)]
        elif isinstance(node, dict):
            node = node.get(part)
        else:
            return None
    return node


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return value
    return yaml.safe_dump(value, sort_keys=False).rstrip("\n")


def cmd_yaml_value(args: argparse.Namespace) -> int:
    data = _load_yaml(args.file)
    print(_as_text(_resolve_path(data, args.path)))
    return 0


def cmd_yaml_multiline(args: argparse.Namespace) -> int:
    data = _load_yaml(args.file)
    value = _resolve_path(data, args.path)
    if isinstance(value, str) and "\n" in value:
        print(value)
    else:
        print("")
    return 0


def cmd_yaml_array_length(args: argparse.Namespace) -> int:
    data = _load_yaml(args.file)
    value = _resolve_path(data, args.path)
    print(len(value) if isinstance(value, list) else 0)
    return 0


def cmd_yaml_string_list(args: argparse.Namespace) -> int:
    data = _load_yaml(args.file)
    value = _resolve_path(data, args.path)
    if isinstance(value, list):
        out = []
        for item in value:
            if item is None:
                continue
            text = str(item).strip()
            if text:
                out.append(text)
        print("\n".join(out))
    else:
        print("")
    return 0


def _as_int(value: Any) -> int:
    if value is None or isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        cleaned = re.sub(r"[^0-9-]", "", value)
        if cleaned in {"", "-"}:
            return 0
        try:
            return int(cleaned)
        except ValueError:
            return 0
    return 0


def _tokens_from_usage(usage: Any) -> tuple[int, int, int, int, int, int] | None:
    if not isinstance(usage, dict):
        return None
    ai_created = _as_int(usage.get("ai_created_tokens", usage.get("aiCreatedTokens")))
    input_tokens = _as_int(
        usage.get(
            "input_tokens",
            usage.get("prompt_tokens", usage.get("inputTokens", usage.get("promptTokens"))),
        )
    )
    cached_tokens = _as_int(usage.get("cached_tokens", usage.get("cachedTokens")))
    output_tokens = _as_int(usage.get("output_tokens", usage.get("outputTokens")))
    reasoning_tokens = _as_int(usage.get("reasoning_tokens", usage.get("reasoningTokens")))
    total_tokens = _as_int(usage.get("total_tokens", usage.get("totalTokens")))
    if total_tokens == 0:
        total_tokens = input_tokens + cached_tokens + output_tokens + reasoning_tokens
    return (ai_created, input_tokens, cached_tokens, output_tokens, reasoning_tokens, total_tokens)


def _find_usage(node: Any) -> tuple[int, int, int, int, int, int] | None:
    if isinstance(node, dict):
        direct = _tokens_from_usage(node)
        if direct is not None and any(direct):
            return direct
        if "usage" in node:
            found = _tokens_from_usage(node.get("usage"))
            if found is not None:
                return found
        for value in node.values():
            found = _find_usage(value)
            if found is not None:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _find_usage(value)
            if found is not None:
                return found
    return None


def cmd_parse_copilot_metrics(args: argparse.Namespace) -> int:
    text = args.text or ""
    candidates: list[str] = []
    stripped = text.strip()
    if stripped:
        candidates.append(stripped)
    candidates.extend(
        line.strip() for line in text.splitlines() if line.strip().startswith("{") and line.strip().endswith("}")
    )
    first = text.find("{")
    last = text.rfind("}")
    if first != -1 and last != -1 and last > first:
        candidates.append(text[first : last + 1].strip())

    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except Exception:
            continue
        usage = _find_usage(data)
        if usage is not None:
            print("|".join(str(x) for x in usage))
            return 0

    input_match = re.search(r"input_tokens[:=]\s*([0-9][0-9,]*)", text, re.IGNORECASE)
    output_match = re.search(r"output_tokens[:=]\s*([0-9][0-9,]*)", text, re.IGNORECASE)
    total_match = re.search(r"total_tokens[:=]\s*([0-9][0-9,]*)", text, re.IGNORECASE)
    input_tokens = int(input_match.group(1).replace(",", "")) if input_match else 0
    output_tokens = int(output_match.group(1).replace(",", "")) if output_match else 0
    total_tokens = int(total_match.group(1).replace(",", "")) if total_match else input_tokens + output_tokens
    print(f"0|{input_tokens}|0|{output_tokens}|0|{total_tokens}")
    return 0


def cmd_validate_agent_md(args: argparse.Namespace) -> int:
    file = Path(args.file)
    if not file.exists():
        print("FAIL: file not created")
        return 1

    content = file.read_text(encoding="utf-8", errors="replace")
    lines = content.splitlines()
    errors: list[str] = []

    if not lines[:5] or not any(line.startswith("---") for line in lines[:5]):
        errors.append("missing YAML frontmatter")
    if not re.search(r"^name:", content, re.MULTILINE):
        errors.append("missing name: in frontmatter")
    if not re.search(r"^description:", content, re.MULTILINE):
        errors.append("missing description: in frontmatter")
    if not re.search(r"^tools:", content, re.MULTILINE):
        errors.append("missing tools: in frontmatter")

    known_tools = {
        "scaffold-generator",
        "security-scanner",
        "usage-tracker",
        "azure-inspector",
        "azure-resource-status",
        "ci-monitor",
        "deploy-verifier",
        "contract-compliance",
        "repo-index",
        "lint-local",
        "terraform-local",
        "git-pr-orchestrator",
    }
    m = re.search(r"^tools:\s*(.+)$", content, re.MULTILINE)
    if m:
        for tool in re.findall(r'"([^"]+)"', m.group(1)):
            if tool not in known_tools:
                errors.append(f"unknown tools: {tool}")

    if args.repo_path not in content:
        errors.append(f"missing reference to {args.repo_path}")
    if "anti-pattern" not in content.lower():
        errors.append("missing Anti-Patterns section")
    if args.role == "infra" and "platform guardrails" not in content.lower():
        errors.append("missing Platform Guardrails section for infra")

    if errors:
        print("FAIL: " + "; ".join(errors) + ";")
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="init-helpers")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("yaml-value")
    p.add_argument("--file", required=True)
    p.add_argument("--path", required=True)
    p.set_defaults(func=cmd_yaml_value)

    p = sub.add_parser("yaml-multiline")
    p.add_argument("--file", required=True)
    p.add_argument("--path", required=True)
    p.set_defaults(func=cmd_yaml_multiline)

    p = sub.add_parser("yaml-array-length")
    p.add_argument("--file", required=True)
    p.add_argument("--path", required=True)
    p.set_defaults(func=cmd_yaml_array_length)

    p = sub.add_parser("yaml-string-list")
    p.add_argument("--file", required=True)
    p.add_argument("--path", required=True)
    p.set_defaults(func=cmd_yaml_string_list)

    p = sub.add_parser("parse-copilot-metrics")
    p.add_argument("--text", default="")
    p.set_defaults(func=cmd_parse_copilot_metrics)

    p = sub.add_parser("validate-agent-md")
    p.add_argument("--file", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--role", required=True)
    p.add_argument("--repo-path", required=True)
    p.set_defaults(func=cmd_validate_agent_md)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
