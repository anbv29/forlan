# BYOK Agent MCP

Local coding tasks through MCP using your own inference credentials.
Independent implementation inspired by the Alan report; no Alan binaries or services.

## Setup

Requires Node.js 24+, Git, a committed repository and a stdio-capable MCP client.

1. Run npm ci.
2. Copy config.example.json to config.local.json.
3. Set absolute repository and stateDir paths; stateDir must be outside repositories.
4. Set baseUrl to an OpenAI-compatible API prefix, including /v1 when required.
5. Select a function-calling model. The server appends /chat/completions.
6. Configure the client to launch node with the absolute path to src/server.mjs.
7. Pass BYOK_CONFIG (absolute config path) and BYOK_API_KEY through client environment settings.

Keep API keys in client-managed secrets or inherited environment variables.
Do not paste keys into chat, task goals or tool arguments.
The server does not load .env files. Consumer chat subscriptions do not supply API credits.
Local unauthenticated models can use loopback HTTP; remote endpoints require HTTPS.
Hosted clients requiring remote MCP cannot directly use this stdio build.

Example client configuration; adapt the surrounding structure to your client:

```json
{
  "mcpServers": {
    "byok-agent": {
      "command": "node",
      "args": ["C:/absolute/path/to/project/src/server.mjs"],
      "env": { "BYOK_CONFIG": "C:/absolute/path/to/config.local.json" }
    }
  }
}
```

Supply BYOK_API_KEY separately using your client's secret/environment support.

## Agents and approval checkpoints

Configure agents as a map of names to profiles. Kinds are byok, codex and claude.
CLI profiles require an absolute native executable command; for an npm CLI use
node.exe followed by its absolute JavaScript entry point. Do not launch .cmd or .ps1 wrappers.
Use defaultAgent to select a single default runner. Optional model overrides are per profile.
Use start_task with agents: ["codex", "reviewer"] for a sequential pipeline.
Stages share one worktree, earlier summaries and the current diff. They do not edit concurrently.
Separate tasks can still execute concurrently up to maxConcurrent.
Set readOnly: true for a reviewer. BYOK stages enforce read-only tool access; CLI stages
select Codex read-only sandbox or Claude plan mode with read-only file tools.
This does not add a new operating-system sandbox around Claude.

requireApproval defaults to true for loaded configurations. Tasks pause before the
first stage and each subsequent stage. Inspect status/diff, then call review_checkpoint
with taskId and stageIndex. A client form asks the human to approve or reject.
A model cannot supply approval in tool arguments. Canceling the prompt leaves the task paused.
Clients without form elicitation cannot approve; they can still inspect or cancel.
An owner can explicitly disable checkpoints with requireApproval: false in the config.
Pending checkpoints survive restart. Interrupted active stages still do not resume automatically.
Approval authorizes the next stage and its configured verification workflow.

CLI authentication can use the CLI account already configured on the machine, or a
profile apiKeyEnv. Only that profile key is passed as CODEX_API_KEY or ANTHROPIC_API_KEY.
These native agents manage their own inference and permissions; their credentials
may be inherited by processes they launch. Server-owned check commands omit provider keys.
If only CLI profiles are configured, global BYOK model, baseUrl and key are optional.
agentTimeoutMs bounds each CLI process; maxSteps bounds BYOK tool rounds and Claude turns.
Codex has a deadline but no equivalent model-step limit.

The multi-agent example is config.pipeline.example.json. Replace every path, configure
its three key environment variables, and use a client supporting form elicitation.
Use config.example.json for a BYOK-only installation. No keys belong in either JSON file.

## Tools

| Tool | Purpose |
| --- | --- |
| get_configuration | Inspect roots, model and checks without credentials |
| start_task | Start work and return its ID immediately |
| list_tasks | List the latest 100 tasks |
| get_task_status | Read state, branch, summary and verification |
| get_task_events | Poll events after a sequence cursor |
| get_task_diff | Review tracked changes and untracked file names |
| read_task_file | Review file contents, including new files |
| run_checks | Rerun owner-configured commands |
| cancel_task | Request cancellation |
| list_agents | Inspect named profiles without credentials |
| review_checkpoint | Ask the human to approve or reject a stage |

Ask your client to start a small task, poll status, then show its diff and new files.
Tasks use a new branch and worktree based on committed HEAD.
Uncommitted source changes are not copied; the original checkout remains untouched.
No task changes are automatically committed, pushed or merged.

## Verification and lifecycle

Checks are executable-and-argument arrays with no shell parsing.
On Windows prefer node with explicit script paths; .cmd wrappers are not interpreted.
Project dependencies must already be available in the worktree.
Checks run after model completion. Unconfigured checks never count as passed.
Paused tasks use awaiting_approval. Terminal states include needs_review, checks_failed, failed and cancelled.
Closing the client cancels active operations; pending checkpoints remain paused. The server must remain running.
Restart marks unfinished records interrupted without resuming them.
Worktrees, branches and SQLite history remain for inspection; cleanup is manual.

## Boundaries

Worktrees separate changes, not operating-system permissions.
Configured checks run repository code with your account's access.
Use trusted repositories and check commands; use containers for untrusted code.
File tools reject traversal, .git, .env files, links and alternate file streams.
This is not a race-proof filesystem or network sandbox.
Files read by the model are sent to your configured provider.
Other secret-bearing files are not automatically detected.
Provider keys are redacted from task records and omitted from server-owned check environments.
Native CLI agents receive their selected credentials and use their own permission controls.
Usage is recorded when provided. Limits do not guarantee a monetary budget.
Direct Anthropic API integration, cloud hosting, scheduling and parallel stages within one task are future work.

## Tests and Git history

Run npm run check and npm test. Fourteen behavior tests use a local mock provider and CLI subprocess fixtures,
real Git worktrees and the real MCP transport without spending API credits.
Installed Codex and Claude CLI help was checked. Authenticated live model runs have not been tested.
CLI contracts: https://developers.openai.com/codex/noninteractive and https://code.claude.com/docs/en/cli-reference

This session blocks writes to the default .git directory. Actual commits are in
work/byok-history. Inspect them with ./scripts/git.ps1 log --oneline.
The source package includes a Git bundle for restoring ordinary repository history:
git clone byok-agent-mcp.bundle byok-agent-mcp
Implementation commits contain 100–140 changed JavaScript lines.
Generated lockfiles and documentation have separate line counts.
