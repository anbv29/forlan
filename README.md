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

Ask your client to start a small task, poll status, then show its diff and new files.
Tasks use a new branch and worktree based on committed HEAD.
Uncommitted source changes are not copied; the original checkout remains untouched.
No task changes are automatically committed, pushed or merged.

## Verification and lifecycle

Checks are executable-and-argument arrays with no shell parsing.
On Windows prefer node with explicit script paths; .cmd wrappers are not interpreted.
Project dependencies must already be available in the worktree.
Checks run after model completion. Unconfigured checks never count as passed.
Terminal states include needs_review, checks_failed, failed and cancelled.
Closing the client cancels active operations. The server must remain running.
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
Provider keys are redacted from task records and omitted from command environments.
Usage is recorded when provided. Limits do not guarantee a monetary budget.
Direct Anthropic APIs, cloud hosting, scheduling and multi-agent execution are future work.

## Tests and Git history

Run npm run check and npm test. Eight behavior tests use a local mock provider,
real Git worktrees and the real MCP transport without spending API credits.
Live provider compatibility has not been tested.

This session blocks writes to the default .git directory. Actual commits are in
work/byok-history. Inspect them with ./scripts/git.ps1 log --oneline.
The source package includes a Git bundle for restoring ordinary repository history:
git clone byok-agent-mcp.bundle byok-agent-mcp
Implementation commits contain 100–140 changed JavaScript lines.
Generated lockfiles and documentation have separate line counts.
