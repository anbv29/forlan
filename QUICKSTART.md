# Use Forlan with Codex

Forlan coordinates coding agents through MCP in isolated Git worktrees. It runs
locally through your existing MCP client, without a separate desktop application.
Requires Node.js 24+, Git, and a target repository with a committed HEAD.

For the downloadable npm archive, run:

```powershell
npm.cmd install --global .\forlan-1.0.1.tgz
forlan setup --repository C:\path\to\your\project --register
```

The steps below are for a Git clone.

## Install and connect

Clone the repository and open its folder in PowerShell. In this workspace that
folder is `C:\Users\anubh\Desktop\new-chat-5`. Run:

```powershell
npm.cmd ci
npm.cmd run setup -- --repository C:\path\to\your\project --register
npm.cmd run doctor
npm.cmd run smoke
codex.cmd mcp get forlan
```

Setup creates `config.local.json` and registers absolute paths with Codex. Existing
configuration is preserved. Restart Codex after registration; the current chat
cannot hot-load new MCP tools. In Codex CLI, `/mcp` shows connection status.

When updating an existing installation, remove its previous MCP registration and
rerun setup with `--register`. The new registration is named `forlan` and passes
`FORLAN_CONFIG`. If an earlier archive is installed globally, uninstall that
package before installing this one, since both expose the same `forlan` command.

Sign in with `codex.cmd login` before model tasks. Setup detects the standard
Windows npm installation; other installations can pass `--codex-entry` with the
absolute path to `codex.js`. If registration is denied in this session, run it
from your own normal terminal. Administrator access is not required.

The default profiles are `codex` and a read-only `reviewer`, with approval
checkpoints enabled. Set `checks` to commands appropriate for your repository,
for example `[["node", "--test"]]`. Empty checks never count as passed tests.
State defaults to `.forlan` in your user home and must stay outside every
configured repository. Preserve that directory to retain task history.

## BYOK and other clients

For an OpenAI-compatible provider, copy `config.example.json` to `config.local.json`
and set repository/state paths, baseUrl, model and verification commands. Supply
FORLAN_API_KEY through the MCP client's environment or secret settings. Never put
keys in configuration files, task goals or chat. ChatGPT subscriptions do not
provide BYOK API credits; CLI agents can use their own configured sign-in.

Other stdio MCP clients should launch Node with the absolute `src/server.mjs`
path and set FORLAN_CONFIG to the absolute configuration path. Form elicitation is
required to approve work. README.md covers HTTP mode and background execution.

## Ask Codex to use it

Start with:

> Use forlan MCP. Read get_usage_guide and get_configuration, then list_agents.
> Tell me which repository, agents and checks are configured. Do not start coding yet.

Then give it a bounded task:

> Use forlan MCP to add [specific change] in [configured repository].
> Use agents ["codex", "reviewer"]. Request my approval at each checkpoint.
> Monitor the existing task, run configured checks, and show the final diff,
> new files and verification failures. Do not commit or push.

Tasks return an ID immediately. Poll get_task_status/get_task_events and use
review_checkpoint when paused. Approval comes from a human form, never a boolean
tool argument. Clients without form support can inspect and cancel paused work.

For larger goals use plan_project, review_project_plan and integrate_project.
Context tools provide searchable repository notes. Automations start as disabled
drafts and require approval; enabled automations still honor stage checkpoints.

## Review and apply changes

The original checkout stays untouched. Read get_task_diff, read_task_file and
check results. export_task_patch includes tracked edits, deletions and new UTF-8
files. Review and save it as UTF-8 before applying to the original checkout:

```powershell
git apply --check C:\path\to\reviewed.patch
git apply C:\path\to\reviewed.patch
```

No automatic commit or push occurs. Conflicts support approved agent assistance
or explicit contents/deletion decisions. Failed candidates remain separate.
Interrupted work needs explicit recovery; unfinished stages start fresh calls.

## CLI and verification

The package supplies `forlan start`, `service`, `setup`, `doctor` and `smoke`.
From a clone, `node src/cli.mjs --help` shows commands. Use
`node src/cli.mjs --config C:\path\config.json doctor` to select a configuration.

Run `npm.cmd run check` and `npm.cmd test`. All tests run with no skips, even when
loopback is blocked. Portable mode exercises the real stdio subprocess and routes
HTTP bytes through Node's HTTP parser, MCP transports and production handlers
using memory streams. `npm.cmd run test:network` runs the same checks over actual
TCP; GitHub Actions requires that mode on Linux and Windows.
`npm.cmd run test:portable` explicitly selects memory connections.
Doctor and smoke spend no model credits. Fixture results do not prove live model
quality. README.md explains the test modes and background-worker setup.
