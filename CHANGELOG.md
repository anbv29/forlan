# Changelog

## 1.0.1

- Use Forlan consistently for package identity, MCP registration, configuration and state paths.
- Configuration variables use FORLAN_ and the guide resource is forlan://guide.
- Run HTTP session, approval, reconnect and webhook tests in portable mode without skips.
- Exercise production HTTP handlers through Node's parser and in-memory byte streams.
- Verify request parsing and streaming cancellation independently of the MCP workflow.
- Keep TCP validation strict in network mode and CI.

## 1.0.0

First packaged local MCP release of Forlan.

- CLI commands for setup, diagnostics, stdio connection checks and background service.
- 33 MCP tools, a discoverable usage resource and an implementation prompt.
- BYOK inference and Codex/Claude Code profiles with read-only reviewer stages.
- Approved sequential pipelines, parallel plans and isolated Git worktrees.
- Text merging, explicit conflict decisions and isolated resolution candidates.
- Searchable local code context, project notes and interrupted-work recovery.
- Durable schedules/event automations with deduplication and overlap prevention.
- Activity, task status, reported token usage and cost metrics.
- Portable patch export preserving Unicode paths, empty files and whitespace.
- Idempotent shutdown and redacted CLI failure diagnostics.
- Linux/Windows CI for the full suite, including actual HTTP approvals and sessions.
- Loopback capability detection, portable stdio fixtures and strict network test mode.

This is a local single-owner product. Cloud workers, team accounts, browser
verification and native GitHub/Slack/Linear task integrations are outside this
release. Owners supply credentials and appropriate verification commands.
Fixture/transport validation and authenticated live-model validation are separate.
