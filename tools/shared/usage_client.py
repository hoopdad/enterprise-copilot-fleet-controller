"""Direct usage tracker client — call log_usage without going through MCP protocol.

Use this in MCP tool servers to log usage events directly (in-process),
avoiding the overhead of an MCP round-trip to the usage-tracker server.

Usage:
    from shared.usage_client import log_usage_direct

    log_usage_direct(agent="orchestrator", action="task_start", tool="contract-compliance")
"""

from shared.instrumentation import log_usage_direct  # noqa: F401

__all__ = ["log_usage_direct"]

