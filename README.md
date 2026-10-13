# dsh-omo — Oh My DSH-style orchestration

An independent DeepSeek Harness plugin that brings an Oh My OpenCode-inspired specialist workflow to DSH. It is being implemented against the installed DSH `0.2.0-rc.2` APIs; it does **not** install or depend on the incompatible `dsh-autopilot` alpha. No Oh My OpenCode source code is copied. This is an early-stage compatibility layer, not a claim of complete 1:1 feature parity or affiliation with either project.

## First milestone

- Adds `dsh_omo_task`, a bounded one-shot launcher with automatic parent follow-up, and an opt-in `dsh_omo_task_continuable` tool backed by DSH durable child sessions. Specialist roles include `explore`, `librarian`, `architect`, `plan-consultant`, `plan-reviewer`, `ultrabrain`, `quick`, `visual`, `reviewer`, `test`, and `security`.
- Adds role personas, opt-in per-role model routes, reasoning effort and token ceilings, inherited tool-scope allow/deny filters, and bounded literal `promptAppend` guidance in delegated task messages.
- Adds twelve packaged workflow skills: four `/omo-*` skills plus `debugging`, `frontend`, `git-master`, `init-deep`, `remove-ai-slops`, `review-work`, `security-research`, and `visual-qa`; these guides do not reproduce upstream lifecycle integrations.
- Adds a cwd-aware provider for project `.opencode/skills` and `.claude/skills` files through DSH skill/filesystem services.
- Adds `/omo-skills-refresh` to invalidate the project-skill catalog after local edits; filesystem watchers normally refresh it automatically.
- Adds persistent system-prompt guidance for task decomposition, parallel delegation, integration, and verification.
- Adds `/ulw`, `/ultrawork`, `/architect`, `/review`, `/handoff`, `/refactor`, `/remove-ai-slops`, `/omo`, `/omo-tasks`, `/omo-interrupt`, and `/omo-skills-refresh`; `/goal` and read-only `/omo-models` are registered when their optional native DSH services are available. `/stop-continuation` is registered only when the native DSH Goal service exposes `get` and `clear`. Task commands still report DSH residency/interrupt attempts, not plugin origin or guaranteed completion.
- Adds opt-in native Agent Teams tools (`enableTeamTools: true`) when the DSH `agentTeams` service exists; DSH remains authoritative for Team membership, permissions, persistence, messages, and task revisions.
- Adds user-configured category-to-single-route delegation via `categoryRoutes` and optional `category` arguments; categories select a model route only, not a persona, fallback chain, or built-in upstream category registry.
- Adds on-demand `/omo-models` diagnostics over registered DSH providers and exact model metadata. It does not query models unless the user names a `provider/model`, and it is not the upstream `models.dev` cache/refresh system.
- Adds opt-in read-only `session_search` (`enableSessionSearch: true`) when DSH `sessionQuery` is available. Search defaults to the current Agent session cwd; cross-project search requires `includeOtherProjects: true`. Results are bounded snippets, not log bodies; a cold workspace observation or search indexing may still do full-session work internally, and index completeness is backend-dependent.
- Adds separately opt-in `session_read` (`enableSessionRead: true`) for one DSH `readEvent` window. It defaults to the current workspace and target-only reads, caps explicitly requested context to four events on either side (subject to any stricter Host limit), and returns only bounded direct-user/model-assistant text, omitting synthetic user-role context, system/developer content, reasoning, tool calls/results, and attachments; it does not expose a full session or resume it, though RC2 `readEvent` loads/snapshots the complete target log before slicing the bounded response window (live sources snapshot all events; persisted sources read/reconstruct the full log); a cold current-Agent workspace observation may also prepare that Agent's full log.
- Adds separately opt-in `session_list` (`enableSessionList: true`) for bounded metadata-only listing. It defaults to the current workspace, supports inclusive date bounds, caps output at 25 records, and has no stable page cursor; the Host materializes the complete logical corpus before filtering. Though results are metadata-only, a cold current-Agent workspace observation may prepare that Agent's full event log.
- Adds separately opt-in `session_info` (`enableSessionInfo: true`) for one session's allowlisted header and optional bounded title. Title lookup snapshots/scans the entire live target log or reads/reconstructs the complete persisted target log on every call; it returns no event text or message statistics. Default scope is the current workspace; global scope is only a model-supplied selector, not authorization.
- Adds optional DSH Host job monitoring (`enableJobTools: true`) through `dsh_omo_job_list` and `dsh_omo_job_follow`. It defaults off, derives the service owner from the current Agent, caps streams/output, drops `JobView.detail` and `output.spillPaths`, and registers no `jobController.kill` adapter. This does not implement OMO `background_output`, `background_cancel`, or subagent-result retrieval.
- Adds `/remove-ai-slops` steering that reuses the bundled workflow skill; it is not an automatic diff hook or enforcement boundary.
- Adds project skills as a source in the DSH skill registry. Provider reads use `ctx.fs`, cwd containment, file-version checks, and a post-read path revalidation—not model-facing filesystem tools or their approval prompts; DSH remains authoritative for normal tool mutations, shell/network access, and approvals.

A role prompt and `allowTools`/`denyTools` filters are not a hard security boundary. In DSH RC2, the subagent tool filter affects inherited global and ancestor-scope tools; the child's own scoped registrations and (when the scope's effective presentation mode is non-native) DSH's reserved PTC `run_code` transport may still be visible. For must-be-read-only work, verify that DSH-native permissions, sandbox policy, or tool guards cover every visible tool, including scoped registrations and the reserved transport; dsh-omo does not install a per-worker hard guard. Project-skill provider reads do not pass through model-facing tool approval or mutation-sandbox checks; they use the mounted DSH filesystem backend, cwd containment, version checks, and post-read path revalidation. The RC2 filesystem contract has no atomic no-follow open, so an adversarial concurrent swap-and-restore could still evade path checks; this is not a race-free OS read sandbox. Treat repository skill content as untrusted and do not use it to expose secrets.

## Install in an isolated profile

Build a local package tarball, then add it to a dedicated profile:

```sh
cd oh-my-dsh
pnpm install
pnpm run check
pnpm pack --pack-destination .artifacts

# Create/seed the isolated audit profile from the shipped web template, then add the tarball.
dsh --profile ohmy-test --from-default-profile web --dump-config
dsh plugin --profile ohmy-test add "$(pwd)/.artifacts/dsh-omo-0.1.9.tgz"
dsh --profile ohmy-test --dump-config
```

The user-facing app should be restarted after adding the package. Test the isolated profile first; only add it to `desktop` after reviewing the effective configuration.

## Configure roles

The package installs a bundle row in `cordis.patch.yml`. Add entries to `roleRoutes` for provider/model, reasoning, token ceilings, inherited tool-scope filters (`allowTools`/`denyTools`), and bounded literal `promptAppend` guidance. For one-shot launches that emit a filter, the DSH subagent provider must advertise `toolFilter`; DSH rejects unsupported filters before publishing a child. Continuable tasks apply the filter through DSH's scoped `tools.restrict` path and do not require that provider capability flag. `enableContinuableTasks` defaults to `false`; turn it on only after verifying the selected DSH subagent provider supports durable continuation:

```yaml
- id: dsh-omo
  name: dsh-omo
  config:
    provider: spawn
    maxConcurrent: 4
    maxDepth: 1
    maxTaskChars: 12000
    maxResultChars: 8000
    enableContinuableTasks: false
    enableTeamTools: false
    enableSessionSearch: false
    enableSessionRead: false
    enableSessionList: false
    enableSessionInfo: false
    enableJobTools: false
    categoryRoutes:
      - name: research
        provider: deepseek-official
        model: deepseek-flash
        reasoningEffort: medium
    roleRoutes:
      - role: explore
        category: research
        allowTools: [read, glob, grep, web_search, web_fetch]
      - role: reviewer
        provider: deepseek-official
        model: deepseek-flash
        reasoningEffort: medium
        maxTokens: 4096
        promptAppend: |-
          Cite one supporting file or source for each finding.
        denyTools: [bash]
```

`enableTeamTools` defaults to `false`; opt in only when the optional DSH `agentTeams` service is present. It exposes ten Host-backed `team_*` tools; write scopes remain advisory and DSH owns authorization and shared state. `enableSessionSearch` also defaults to `false` and requires DSH `sessionQuery.searchSessions` plus `observeSession`; the read-only tool derives the current Agent cwd from a projection-free observation and uses the DSH `sessionFilters: [{ kind: 'cwd', values: [...] }]` contract by default. `includeOtherProjects: true` deliberately removes that filter; the flag is model-supplied, not proof of user consent/authorization or an enforcement boundary; configure DSH tool permissions separately. It bounds results to 20 hits with 600-character snippets, forwards cancellation, returns a cursor for pagination, and does not request full log output or mutate sessions; a cold workspace observation or search indexing may still do full-session work internally. DSH owns search indexing/reconciliation, so completeness and backend availability are not guaranteed. `enableSessionRead` separately defaults to `false` and requires `sessionQuery.readEvent`, `observeSession`, and `filterSessions`. It validates the selected session against the current cwd before reading, defaults to zero neighboring events and allows at most four on either side (the Host may be stricter), and projects only bounded `text` blocks from direct user (`source.kind: 'user'`) and model assistant messages; synthetic user-role context, system/developer messages, reasoning, tool calls/results, and non-text blocks are omitted. It never calls `readSession` or resumes a session; output is bounded, but RC2 `readEvent` loads/snapshots the complete target log before slicing the requested window; a cold current-Agent workspace observation may also prepare that Agent's full log. Historical text is marked untrusted. `includeOtherProjects: true` is model-supplied, not proof of user consent or authorization; use it only after an explicit user request; it does not enforce consent, so configure DSH tool permissions separately. `enableSessionList` separately defaults to `false` and requires `sessionQuery.listSessions`, `filterSessions`, and `observeSession`. It uses the current Agent cwd by default, fails closed if cwd is unavailable, and accepts optional inclusive `fromDate`/`toDate` bounds; output is metadata-only and capped at 25 records. The Host materializes the complete logical corpus before filtering and provides no stable cursor, so a truncated result must be narrowed by workspace or date. Global scope uses the same model-supplied `includeOtherProjects: true` selector; set it only after an explicit user request, since the flag does not enforce consent/authorization. `/goal` is registered only when the native DSH Goals service is available; Goal persistence and continuation remain Host-owned. `/omo-models` is registered only when DSH LLM metadata is available; it lists up to 100 provider rows and resolves a named `provider/model` on demand (lookup scans at most 1,024 provider entries, then reports indeterminate). The command returns on caller cancellation or a 15-second timeout and passes that signal to the adapter; an adapter that ignores cancellation may continue its own work. This is diagnostic metadata, not model validation for child launch or a model request.

`enableSessionInfo` separately defaults to `false` and requires DSH `sessionQuery.readTitleSnapshot`, `filterSessions`, and `observeSession`. The tool accepts one exact session id, preflights exact id and current-cwd filters before reading by default, and revalidates the title observation's id/cwd; `includeOtherProjects: true` switches to an ID-only global lookup only after an explicit user request, but remains a model-supplied selector rather than authorization. Title text is clipped to 400 characters, marked untrusted, and excludes provider/model identifiers and title input message sequences. It does not report message counts, event counts, agent usage, todos, transcripts, or event text. Important cost: RC2 `readTitleSnapshot` snapshots/scans the entire live target event log or reads/reconstructs the complete persisted target log on every call; a cold observation of the current Agent session may also prepare its full event log, and `filterSessions` enumerates the complete metadata corpus before filtering. The response is bounded but the Host I/O is not. The adapter never calls `readSession` or `listEvents`.

`categoryRoutes` is an explicit dsh-omo single-route table (up to 32 names, each at most 64 characters), not an upstream built-in category registry: a task may choose a configured `category`, or `roleRoutes.category` may set that role's default. Category chooses only provider/model/reasoning; the specialist role still controls the prompt, and an explicit role route overrides the category. No category/model fallback chain is implemented, and missing routes still inherit the parent/session model. Shared slash-task steering commands reject raw input longer than `maxTaskChars` before queueing it to the current agent.

`roleRoutes.promptAppend` is a literal UTF-8 string capped at 4,096 bytes before trimming; whitespace-only values within the cap are ignored. dsh-omo rejects disallowed C0/C1 controls (tab and line breaks are allowed) and does not resolve `file://` or network references. It is inserted as an “Additional role guidance” section in the task message after the built-in role title/focus and before fixed task/integration instructions. Those fixed instructions remain prompt guidance, not enforcement. This is not a DSH `persona`/system-prompt append, does not replace the provider’s existing system prompt, and is supported only on `roleRoutes`, not `categoryRoutes`.

`provider` and `model` must be set together when overriding the route; `reasoningEffort` and `maxTokens` may be configured alone and ordinarily merge over the parent route. If provider/model changes without an explicit `reasoningEffort`, inherited effort is cleared so the new model can use its default; do not generalize this to other omitted options. dsh-omo does not preflight category/role routes; DSH may accept the child session and reject an unavailable provider/model/reasoning choice on its first model request. `/omo-models` reports advisory metadata and does not reserve or validate a future route. `allowTools` and `denyTools` are DSH filters over tools inherited from the global and ancestor scopes; restrictions intersect, the child's own scoped registrations remain visible, and these are not hard permission boundaries. An explicit `allowTools: []` is preserved and hides all tools inherited from the global and ancestor scopes, but the child's own scoped registrations and (when the scope's effective presentation mode is non-native) DSH's reserved PTC `run_code` transport may remain; it is not a hard deny-all. Empty `denyTools` is a no-op and is omitted. DSH's retry policy covers same-route request retries; OMO-style cross-model fallback chains are not implemented. `maxConcurrent` limits this plugin's active one-shot runs; DSH owns the separate continuable-session capacity. A parent's `maxTokens` can be inherited at child creation, but RC2 continuable descriptors/cold resume do not persist it; dsh-omo rejects continuable launch if either the role route or parent has `maxTokens`. DSH workers inherit the parent workspace; this plugin does not promise a separate child `cwd`.

## DSH Host job monitoring

`enableJobTools` defaults to `false`. Set it to `true` only when the optional Host `jobController.list` and `jobController.follow` methods are available:

```yaml
enableJobTools: true
```

`dsh_omo_job_list` reads only the initial rows snapshot from the infinite stream, then closes it; output is capped at 50 jobs (25 by default) and 48,000 bytes after serialization/rendering. `dsh_omo_job_follow` derives its owner session from the current `exec.agent.id` (never a model-supplied `sessionId`), accepts an optional absolute byte offset `from`, and bounds each call to 8 seconds, 32 frames, 16 KiB of UTF-8 output, and 48,000 serialized/rendered bytes. It preserves absolute cursors and `lossy`/`gapBefore` indicators while projecting an explicit allowlist; `JobView.detail` and `output.spillPaths` are omitted. The plugin does not register or call `jobController.kill`; any native DSH job-control tools are separate and remain governed by Host policy. Job kinds, labels, and log output are untrusted data. These tools provide DSH job monitoring only; they do not implement OMO `background_output`, `background_cancel`, or background subagent-result retrieval.

## Project skills

The DSH skill registry now discovers project-local skills relative to each skill lookup's `cwd`. Defaults are `.opencode/skills` and `.claude/skills`; each root accepts `<name>/SKILL.md` bundles and top-level `<name>.md` files. Skills need YAML `name` and `description`; optional `whenToUse` becomes top-level routing guidance, while `disable-model-invocation` and `user-invocable` map to DSH invocation flags. Other JSON-compatible frontmatter (including upstream `agent`, `model`, `tools`, or `mcp` fields) is preserved as metadata up to 12 levels deep; YAML aliases are rejected. These fields are not enforced: dsh-omo does not execute embedded MCP or bind the skill to an agent, toolset, or model.

```yaml
- id: dsh-omo
  config:
    projectSkillDirs: [.opencode/skills, .claude/skills]
    disabledSkills: [legacy-skill]
```

`disabledSkills` sets model and user invocation to false only on dsh-omo's bundled/project entries; it does not alter another provider's flags. Disabled entries remain registered, so a lower-priority same-name external skill may still be shadowed by the DSH registry's single-winner resolution. `projectSkillDirs` must be relative to the lookup cwd and cannot contain `..`; only canonical targets under that cwd are accepted, and symlinks resolving outside the configured root are skipped. Reads go through DSH `ctx.fs.readBytes` with a 256 KiB per-file cap; each catalog scan also caps processing at 512 directory entries, 256 accepted skills, and 8 MiB of skill text. `ctx.fs.listDir` returns a complete entry array before the plugin applies its scan cap, so extremely large directories may still cost backend enumeration memory. Reads do not pass through tool-level permission/approval prompts or the mutation sandbox. Reads compare DSH file versions and revalidate the final path after reading, but RC2 exposes no atomic no-follow open; a hostile swap-and-restore race is still possible, so this is not an OS read sandbox or race-free directory-handle boundary. Treat repository-provided skill text as untrusted instructions. Within dsh-omo roots, earlier configured paths rank first; all up to 16 configured roots rank ahead of dsh-omo runtime/bundled skills but remain below higher-priority DSH project sources. Filesystem watchers monitor symlink parents and canonical skill paths when available; if watch setup fails the catalog remains uncached, and `/omo-skills-refresh` can request another scan. User-global and remote skill sources, full OMO priority/config rules, intent activation, and skill-embedded MCP lifecycle remain unsupported.

## Try it

In an interactive DSH session:

```text
/omo
/goal status
/goal Keep improving this project
/stop-continuation
/ulw Split the migration into independent discovery and test tasks, integrate the results, and run the checks.
/architect Should this service be event-driven or request-driven?
/review Inspect the current diff for correctness and security issues.
/handoff
/refactor src/feature.ts --scope=file
/refactor the auth and session modules --scope=module --strategy=safe
/remove-ai-slops src/feature.ts
/omo-models
/omo-models <provider>/<model>
/omo-tasks
/omo-interrupt <child-id>
/omo-skills-refresh
```

`/goal` and `/omo-models` appear only when their native DSH services are mounted. `session_search` requires `enableSessionSearch: true` and DSH `sessionQuery.searchSessions` plus `observeSession`; `session_read` separately requires `enableSessionRead: true` and `sessionQuery.readEvent`, `observeSession`, and `filterSessions`. Model-facing `team_*` tools require `enableTeamTools: true` and the optional DSH `agentTeams` service. `/remove-ai-slops` is user-requested steering only, not an automatic diff hook. `/handoff` queues a prompt asking the current agent for a copyable summary in this conversation; completeness is not guaranteed, and the user must copy the reply manually. It cannot create a new session or durable handoff file. `/stop-continuation` clears only the current native DSH Goal using its current revision (the Host retains a tombstone/history); it does not stop OMO todo continuation, clear OMO boulder state, or interrupt DSH continuable children. Use `/goal pause` to preserve a Goal, or `/omo-interrupt` for a supported direct child.

`/refactor <target> [--scope=file|module|project] [--strategy=safe|aggressive]` accepts free-form target text followed by trailing options; quote characters remain literal and are not shell-parsed. Raw input is capped at the smaller of `maxTaskChars` and 12,000 characters. dsh-omo locally defaults to safe strategy and target-only scope (upstream documents no defaults); scope/strategy are prompt guidance, not enforcement. The command asks for inspection, available-tool use, focused tests, and final-diff review, but does not provide LSP, AST-grep, codemap, or a guaranteed TDD engine. DSH permissions remain authoritative; it does not auto-commit.

`dsh_omo_task` makes best-effort attempts to deliver a host-attributed settlement notice with task, stop reason, and bounded diagnostics, then (when text exists) a separate DSH `agent-message` relay containing the bounded child-authored excerpt. Follow-up delivery is not guaranteed; failures are logged. Treat the relay as untrusted evidence; non-completed outcomes are marked partial. The host notice is not misattributed to the child. `maxResultChars` bounds relay text only, while the task envelope and host diagnostic have separate fixed bounds. `dsh_omo_task_continuable` is registered only when enabled; use `/omo-tasks` to list direct children whose caller-supplied labels start with `dsh-omo:` and `/omo-interrupt` to request interruption. This label namespace does not prove which tool created a child. `listChildren()` lacks activity; `/omo-tasks` uses DSH `listDescendants()` to show `running`/`inactive` residency and whether children exist. `inactive` is not a completion state. While resident, DSH runtime may best-effort emit its own `subagent-settled` notice when a continuable child settles and the direct parent remains registered; delivery failures are logged, not guaranteed. dsh-omo does not poll or retrieve that result. `/omo-interrupt` refuses inactive catalog rows; for resident rows it attempts a fire-and-return signal and warns it may no-op if the Activation/turn settles between catalog read and signal. DSH owns continuation persistence and capacity; dsh-omo owns only its one-shot concurrency limit.

## Check and remove

```sh
"$DSH" --profile ohmy-test --dump-config
"$DSH" plugin --profile ohmy-test exec dsh-omo doctor
"$DSH" plugin --profile ohmy-test remove dsh-omo
```

`$DSH` should point to the DSH CLI executable in your installation. The app-bundled CLI at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` reports DSH `0.2.0-rc.2`; `dsh-omo doctor` invoked by it printed Node `24.18.1`. The isolated `ohmy-test` profile installed `dsh-omo` 0.1.9 and `doctor` reported that version. PNPM emitted a peer-dependency warning during installation; a follow-up `pnpm peers check` is unavailable in the bundled PNPM CLI, so that warning remains unresolved. The fresh `--dump-config` shows base + web + `dsh-omo` with user patch `enableContinuableTasks: true`; this is composition intent, not proof of plugin activation, filesystem service injection, provider capability, or live lifecycle. The separate `desktop` profile bundles the experimental team profile; active desktop was not modified. The 160-test suite uses mocked DSH services and a filesystem test double against the actual RC2 `SkillRegistry`; this verifies provider semantics, not the live DSH filesystem backend or plugin activation. Neither tests nor profile composition establish persistence, cold-resume, or tool-policy parity. Removing the package does not remove session history.

## Parity ledger

This project is staged. The following are working or deferred, not claims that the upstream product has been fully recreated.

| Capability area | Status in this milestone |
| --- | --- |
| One-shot and opt-in continuable specialist tasks | DSH-managed; direct children expose running/inactive residency, but no completion status, plugin-origin proof, result polling, or TTL |
| Ultrawork workflow, packaged skills, and slash commands | Prompt-level task steering, twelve bundled skills, `/remove-ai-slops` steering, optional native `/goal` and `/omo-models`, and partial cwd-relative project skill sources; hooks, plan execution, and recovery remain missing |
| Per-role model selection | Static provider/model/reasoning/token overrides plus user-defined category single-route selection; DSH clears inherited reasoning on route change unless specified; no built-in category defaults, chains, or cross-model fallback |
| Model capability diagnostics | Optional `/omo-models` lists DSH provider IDs and inspects one exact provider/model route on demand; no models.dev cache, refresh job, or launch-time route validation |
| Retry/fallback | DSH handles same-route provider retries; OMO-style model fallback chains are not implemented |
| Permissions/tool scoping | DSH remains authoritative; allowTools/denyTools filter tools inherited from global and ancestor scopes; the child's own scoped registrations and (when the scope's effective presentation mode is non-native) DSH's reserved PTC `run_code` transport remain, so this is not a hard boundary |
| Native Goals, todo/task tracking, Ralph loops, workflows | `/goal` maps status/create/pause/resume/complete/clear to the current live agent's native DSH Goal service when available; persistence and continuation remain Host-owned, and full upstream loops/workflow semantics are not claimed |
| Broader upstream skills, hooks, memory, teams, telemetry, notifications, browser/MCP, LSP | Ten opt-in `team_*` adapters map to DSH `agentTeams`; opt-in bounded `session_search` and event-context-only `session_read` adapters use DSH sessionQuery; full upstream session-list/title/info, full-session read/resume, worktree/tmux, global/remote/MCP skills, and remaining capability adapters are missing |
| Durable task controls, background dashboard, persistent DAG, advanced recovery | Label-matched continuable children expose DSH residency only and can be interrupted; no completion status, result polling, TTL, quotas, dashboard, or task DAG |
| Full agent/category roster and one-to-one command parity | Partial: plan roles and user-defined single-route categories exist; `/refactor` is prompt-only steering, `/handoff` requests a copyable summary in the current conversation (no durable artifact), and `/stop-continuation` clears only the native DSH Goal. Upstream built-in categories, route chains, `/ulw-execute`, and `/hyperplan` remain missing |

The pinned, detailed feature inventory and iterative acceptance loop are in [docs/feature-parity.md](docs/feature-parity.md). Its audit is ongoing; no missing row is silently treated as out of scope.

## License and attribution

This independent implementation uses public DSH extension APIs and is licensed under MIT. It is inspired by published workflow concepts, not copied source code, and is not affiliated with DeepSeek or the Oh My OpenCode / Oh My OpenAgent maintainers.
