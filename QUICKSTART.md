# Use BYOK Agent MCP with Codex

This version lives in `C:\Users\anubh\Downloads\alanAI`. The Desktop project was
used as its starting source and has not been modified. No commits or pushes were made.

## Connect

Open a normal PowerShell terminal and run:

```powershell
Set-Location C:\Users\anubh\Downloads\alanAI
npm.cmd run setup -- --register
codex.cmd mcp get byok-agent
```

Setup preserves the existing `config.local.json`. It registers the absolute Node
executable, server entry point and configuration path with Codex. Restart Codex
or open a new Codex session after registration. In Codex CLI, `/mcp` shows server
status. The currently running chat cannot hot-load the new tools.

The registration attempt inside the build session failed because it could not
write `C:\Users\anubh\.codex\config.toml`. The command above is the remaining step
to run from your own terminal. It does not need an administrator terminal.

For a fresh installation, first run `npm.cmd ci`, then:

```powershell
npm.cmd run setup -- --repository C:\path\to\your\committed-repository --register
```

The setup command detects the usual Windows npm installation of Codex. If yours
is elsewhere, pass `--codex-entry C:\absolute\path\to\codex.js`.

## Current configuration

- Allowed repository: `C:\Users\anubh\Desktop\new-chat-5`.
- Editing agent: `codex`; read-only review agent: `reviewer`.
- Credentials: the Codex CLI's existing sign-in. No provider key was created or saved.
- Approval checkpoints: enabled. Parallelism: at most two active operations.
- State and worktrees: `C:\Users\anubh\Downloads\alanAI\.agent-state`.
- Verification: `node scripts/check.mjs`, which checks JavaScript syntax only.
  This is not the full test suite. Add appropriate checks before relying on validation.

To work on another project, edit the `repositories` array in `config.local.json`
and restart the MCP connection. Use full Git root paths with a committed HEAD.
Uncommitted changes in the source checkout are not copied into task worktrees.
The state directory must be outside every allowed repository. If you add this
Downloads project as a target, move stateDir outside it first.

## Ask Codex to use it

Start with this prompt:

> Use byok-agent MCP. Read get_usage_guide and get_configuration, then list_agents.
> Tell me which repository and runners are configured. Do not start a model task yet.

Then use a bounded implementation prompt:

> Use byok-agent MCP to start a task in C:\Users\anubh\Desktop\new-chat-5.
> Add a test for one missing edge case in the task cancellation flow.
> Use agents ["codex", "reviewer"]. Poll its status, request my approval at each
> checkpoint, and show me the final diff, new files and verification results.
> Do not commit or push.

MCP starts work asynchronously and immediately returns a task ID. Codex should
poll `get_task_status` or `get_task_events`, then use `review_checkpoint` when
the task is `awaiting_approval`. The client must support MCP form elicitation.
If a client cannot display forms, paused tasks can still be inspected/cancelled;
they cannot be approved through a plain chat message or tool argument.

For a larger goal:

> Use plan_project to propose a dependency graph for [goal]. Show me the plan,
> ask for approval through review_project_plan, and monitor its tasks. Once
> complete, ask before integrate_project, then show the combined candidate diff.

For project memory:

> Index the configured repository. Remember that implementation must not commit
> or push, then search its context for cancellation and recovery.

For automation:

> Create a disabled daily automation draft for 10:00 Asia/Kolkata to review
> the configured repository for cancellation regressions with the reviewer agent.
> Show the definition and request approval with review_automation before enabling it.

Automation runs locally while the worker is running. By default each future task
still pauses for stage approval. Unattended execution requires the owner to
explicitly change requireApproval; enabling a schedule does not change it.
Use the background worker in README.md if schedules must survive client disconnects.
Do not run stdio and background workers against the same state directory together.

## Review and take changes back

Tasks edit isolated Git worktrees. They do not modify the original checkout.
Use `get_task_diff`, `read_task_file`, and `run_checks`. `export_task_patch`
returns a Git patch with tracked edits/deletions and new UTF-8 files, up to 150 KB.
Restricted paths and unsupported new binary/large files are rejected. Review and
save the patch as UTF-8, then apply it only when you want those changes:

```powershell
Set-Location C:\Users\anubh\Desktop\new-chat-5
git apply --check C:\path\to\reviewed.patch
git apply C:\path\to\reviewed.patch
```

No automatic commit, push or merge is performed. Conflicting project branches
can be handled with get_conflict_details, submit_conflict_resolutions or
resolve_project_conflicts, with human approval and a separate candidate worktree.

## Diagnose

```powershell
Set-Location C:\Users\anubh\Downloads\alanAI
npm.cmd run doctor
npm.cmd run smoke
npm.cmd run check
npm.cmd test -- --test-timeout=30000
```

Doctor checks Node, committed repository roots and CLI availability. Smoke starts
a real stdio MCP connection, lists tools/resources/prompts, reads configuration,
and exits. Neither spends model credits or starts coding work. Stop an existing
server before smoke if it owns the same state directory.

Actual authenticated inference is separate from transport tests. A Codex sign-in
must already work (`codex.cmd login status`). BYOK profiles instead need their
own provider credentials and API credits; a ChatGPT subscription is not an API key.

If you move this folder, rerun setup with --register and update the absolute
stateDir/configuration paths. Keep the same state directory to retain task history.
