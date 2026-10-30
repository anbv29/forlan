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

## Planned parallel projects

Use plan_project for a goal that needs several tasks. The selected planner inspects
the committed repository read-only and returns up to twelve nodes with explicit dependencies.
Planning itself calls the model. No implementation tasks start until a human approves
the proposed graph through review_project_plan.

The scheduler starts independent nodes concurrently up to maxConcurrent. Each node
uses its own branch and worktree pinned to the plan's base commit. Dependencies must
finish successfully before a dependent task starts. Their text-file additions,
edits and deletions are transferred into the dependent worktree with summaries.
Normal per-stage approval checkpoints still apply when requireApproval is enabled.

Inspect project status for node task IDs and per-node results. Review children using
the existing diff and file tools. A project reaching needs_review with phase execution
has completed child tasks but has not yet combined their branches.

Call integrate_project to ask the human for final integration approval. The server
combines completed leaf-task changes into the project's worktree and runs configured
checks again. The original checkout is untouched. No commits, pushes or merges into
the original branch happen automatically.

Independent text edits to the same file are merged against the common Git base.
Overlapping edits stop at integration_conflict and can be proposed to a resolver
agent after human approval. Binary files and files
above 100 KB are unsupported for dependency transfer; each snapshot is limited to
500 files and 1 MB. Do not externally edit completed child worktrees while dependents
or final integration are reading their changes.

Failures block dependent nodes while independent work can finish. Cancellation of
a project stops active children and cancels queued children. Restart pauses approved
project queues as paused_project. Use resume_project explicitly to continue waiting
work; interrupted active children are never silently rerun. Inspect their worktrees
and create a new plan when an interrupted child prevents safe continuation.

Suggested flow: plan_project, inspect status, review_project_plan, approve child
checkpoints, inspect all child diffs, integrate_project, inspect the combined diff.
MCP form elicitation is required for plan and integration approval even when
per-stage requireApproval is disabled.

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
| plan_project | Generate a read-only dependency plan |
| review_project_plan | Ask the human to approve the task graph |
| resume_project | Explicitly resume a paused approved project |
| integrate_project | Approve combined changes and final checks |
| resolve_project_conflicts | Approve an agent resolution candidate |
| create_automation | Save a disabled automation draft |
| list_automations | Inspect definitions, scheduling and health |
| get_automation | Inspect a definition and run history |
| review_automation | Authorize future runs through a human form |
| disable_automation | Stop future triggers and cancel queued runs |
| trigger_event | Deliver a deduplicated named event |

Ask your client to start a small task, poll status, then show its diff and new files.
Tasks use a new branch and worktree based on committed HEAD.
Uncommitted source changes are not copied; the original checkout remains untouched.
No task changes are automatically committed, pushed or merged into the original checkout.

## Conflict resolution

Integration now uses the common Git base for three-way text merging. Independent edits
to one file merge automatically. Identical edits and unchanged-versus-deleted versions
are handled without choosing an arbitrary winner. Overlapping edits and ambiguous
add/delete conflicts stop integration before candidate changes are applied.

For overlapping text edits, call resolve_project_conflicts with a project taskId and,
optionally, a configured editing agent. A human form must approve the additional
inference. The resolver receives all versions and proposes a combined file.
BYOK writes are limited to conflict paths; native CLI agents use their own controls.
The server audits unrelated changes, rejects remaining conflict markers and reruns
configured checks. The result is a candidate for human review, never an automatic
commit or push. Passing checks do not prove that an agent understood both intentions.
Add/delete decisions, oversized conflicts and unsupported binary files remain manual.
A failed resolver can leave its candidate in the project worktree for inspection.

## Scheduled and event-triggered automations

Use create_automation to save a disabled draft with a fixed name, repository, goal,
agents and trigger. review_automation asks the human to authorize future runs of that
exact definition. Use list_automations and get_automation for next occurrences,
run history and the associated task IDs. Definitions are immutable except for
enablement; create a new draft to change their execution instructions.

Supported triggers:
- once: at is a future ISO timestamp with a timezone.
- interval: everySeconds is 60–31536000, with optional ISO startAt.
- daily: time is HH:mm and timeZone is an explicit IANA zone, such as Asia/Kolkata.
- event: eventType is a fixed name such as repository.changed.

Daily runs occur once per local calendar date during repeated daylight-saving hours.
Nonexistent daily wall times are skipped. Missed occurrences coalesce instead of
creating a catch-up burst. One pending run per definition is allowed; new occurrences
while its previous run is pending are recorded as skipped. All jobs share the
existing global concurrency limit with manual tasks and project nodes.

Automations honor requireApproval. With the default true setting, a scheduled task
waits at its normal stage checkpoint. For unattended inference, the owner must
explicitly set requireApproval: false before enabling the automation; this setting
also affects manual tasks. Enabling a definition never silently changes this policy.
disable_automation stops future triggers and cancels undispatched jobs; an already
started task must be stopped using cancel_task when desired.

The server must remain running. These are local background jobs, not an OS service
or cloud worker. Enabled future schedules survive restart. Interrupted runs are
recorded as interrupted and never replayed automatically. Disabling a rule does
not delete its audit history. Rule, event and run records persist in SQLite.

trigger_event accepts eventId, type, optional repository and optional object payload.
Reuse the same ID for identical retries; reuse with different content is rejected.
An event cannot choose a new goal, executable or agent. Payloads are excluded from
model context unless includeEventPayload was approved, then labeled untrusted data.
Built-in events are task.ready_for_review, task.failed and project.integrated.
Automation-generated tasks do not emit another automatic event, preventing loops.

Optional authenticated loopback endpoint:
add automationWebhook: { port: 8787, tokenEnv: "AUTOMATION_EVENT_TOKEN" } to server
configuration. Supply a random token of at least 32 characters through that environment
variable. The listener binds only to 127.0.0.1 and accepts POST /events with
Authorization: Bearer <token> and Content-Type: application/json.
HTTP envelopes use id rather than the MCP tool's eventId:
{"id":"delivery-123","type":"repository.changed","payload":{"branch":"main"}}
Bodies are capped at 64 KB and payload objects at 8 KB. Browser-origin requests are
rejected. This is a generic local event interface; service-specific webhook signatures
must be verified by a trusted relay before translating provider deliveries.
The endpoint address and health appear in list_automations and get_configuration;
tokens do not. It is not a public GitHub/Slack endpoint or an OAuth MCP transport.

See automation.examples.json for tool argument examples and
config.automation.example.json for an optional endpoint configuration.

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
Direct Anthropic API integration, cloud hosting, service-specific event adapters and shared team memory are future work.

## Tests and Git history

Run npm run check and npm test. Thirty-five behavior tests use a local mock provider and CLI subprocess fixtures,
real Git worktrees and the real MCP transport without spending API credits.
Installed Codex and Claude CLI help was checked. Authenticated live model runs have not been tested.
CLI contracts: https://developers.openai.com/codex/noninteractive and https://code.claude.com/docs/en/cli-reference

This session blocks writes to the default .git directory. Actual commits are in
work/byok-history. Inspect them with ./scripts/git.ps1 log --oneline.
The source package includes a Git bundle for restoring ordinary repository history:
git clone byok-agent-mcp.bundle byok-agent-mcp
Implementation commits contain 100–140 changed JavaScript lines.
Generated lockfiles and documentation have separate line counts.
