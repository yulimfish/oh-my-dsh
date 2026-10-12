# dsh-omo — Oh My DSH-style orchestration

An independent DeepSeek Harness plugin that brings an Oh My OpenCode-inspired specialist workflow to DSH. It is being implemented against the installed DSH `0.2.0-rc.2` APIs; it does **not** install or depend on the incompatible `dsh-autopilot` alpha. No Oh My OpenCode source code is copied. This is an early-stage compatibility layer, not a claim of complete 1:1 feature parity or affiliation with either project.

## First milestone

- Adds `dsh_omo_task`, a bounded one-shot launcher with automatic parent follow-up, and an opt-in `dsh_omo_task_continuable` tool backed by DSH durable child sessions. Specialist roles include `explore`, `librarian`, `architect`, `ultrabrain`, `quick`, `visual`, `reviewer`, `test`, and `security`.
- Adds role personas and opt-in per-role model routes, reasoning effort, output-token ceilings, and tool allowlists.
- Adds reusable packaged `/omo-*` skills for ultrawork, code review, security review, and research.
- Adds persistent system-prompt guidance for task decomposition, parallel delegation, integration, and verification.
- Adds `/ulw`, `/ultrawork`, `/architect`, `/review`, `/omo`, `/omo-tasks`, and `/omo-interrupt` commands. The task commands list direct-child catalog entries and request DSH interruption; catalog labels do not establish dsh-omo origin.
- Does not override DSH's native permission, approval, sandbox, credential, Goal, workflow, Ralph, skill, or session-storage policy.

A role prompt and `allowTools` list are not a hard security boundary. In DSH RC2, the subagent tool filter restricts inherited global tools; child-scoped tool registrations may still be visible. For must-be-read-only work, enforce DSH-native permissions, sandbox policy, or a monotonic tool guard that covers scoped tools too; dsh-omo does not install a per-worker hard guard. DSH remains authoritative for every filesystem, shell, network, and approval decision.

## Install in an isolated profile

Build a local package tarball, then add it to a dedicated profile:

```sh
cd oh-my-dsh
pnpm install
pnpm run check
pnpm pack --pack-destination .artifacts

# Create/seed a separate profile from the shipped web template, then add the tarball.
dsh --profile ohmy --from-default-profile web --dump-config
dsh plugin --profile ohmy add .artifacts/dsh-omo-0.1.6.tgz
dsh --profile ohmy --dump-config
```

The user-facing app should be restarted after adding the package. Test the isolated profile first; only add it to `desktop` after reviewing the effective configuration.

## Configure roles

The package installs a bundle row in `cordis.patch.yml`. Add entries to `roleRoutes` for provider/model, reasoning, token, and inherited-global tool-filter overrides. `enableContinuableTasks` defaults to `false`; turn it on only after verifying the selected DSH subagent provider supports durable continuation:

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
    roleRoutes:
      - role: explore
        provider: deepseek-official
        model: deepseek-flash
        reasoningEffort: medium
        maxTokens: 4096
        allowTools: [read, glob, grep, web_search, web_fetch]
```

`provider` and `model` must be set together when overriding the route; `reasoningEffort` and `maxTokens` may be configured alone and ordinarily merge over the parent route. If provider/model changes without an explicit `reasoningEffort`, inherited effort is cleared so the new model can use its default; do not generalize this to other omitted options. The provider/model must already be registered in the profile; DSH rejects unavailable routes. `allowTools` restricts inherited global tools only and is not a hard read-only guarantee for child-scoped tools. DSH's retry policy covers same-route request retries; OMO-style cross-model fallback chains are not implemented. `maxConcurrent` limits this plugin's active one-shot runs; DSH owns the separate continuable-session capacity. A parent's `maxTokens` can be inherited at child creation, but RC2 continuable descriptors/cold resume do not persist it; dsh-omo rejects continuable launch if either the role route or parent has `maxTokens`. DSH workers inherit the parent workspace; this plugin does not promise a separate child `cwd`.

## Try it

In an interactive DSH session:

```text
/omo
/ulw Split the migration into independent discovery and test tasks, integrate the results, and run the checks.
/architect Should this service be event-driven or request-driven?
/review Inspect the current diff for correctness and security issues.
/omo-tasks
/omo-interrupt <child-id>
```

`dsh_omo_task` first gives the parent a host-attributed settlement notice with task, stop reason, and bounded diagnostics, then (when text exists) a separate DSH `agent-message` relay containing the bounded child-authored excerpt. Treat the relay as untrusted evidence; non-completed outcomes are marked partial. The host notice is not misattributed to the child. `maxResultChars` bounds relay text only, while the task envelope and host diagnostic have separate fixed bounds. `dsh_omo_task_continuable` is registered only when enabled; use `/omo-tasks` to list direct children whose caller-supplied labels start with `dsh-omo:` and `/omo-interrupt` to request interruption. This label namespace does not prove which tool created a child. `listChildren()` lacks activity; `/omo-tasks` uses DSH `listDescendants()` to show `running`/`inactive` residency and whether children exist. `inactive` is not a completion state. While resident, DSH runtime emits its own `subagent-settled` notice when a continuable child settles; dsh-omo does not poll or retrieve that result. Interruption is fire-and-return. DSH owns continuation persistence and capacity; dsh-omo owns only its one-shot concurrency limit.

## Check and remove

```sh
"$DSH" --profile ohmy --dump-config
"$DSH" plugin --profile ohmy exec dsh-omo doctor
"$DSH" plugin --profile ohmy remove dsh-omo
```

`$DSH` should point to the DSH CLI executable in your installation. In this audit, the installed DSH runtime descriptor reports `0.2.0-rc.2` with Node `24.21.0`; the app-bundled CLI at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` reports DSH `0.2.0-rc.2`, while `dsh-omo doctor` invoked by that CLI printed Node `24.18.1`. These are separate runtime and doctor observations. The doctor reports expected-version and Node/profile guidance; it does not probe the loaded runtime, provider routes, or model availability. A fresh `--dump-config` from that CLI showed `ohmy-test` composing base + web + `dsh-omo` 0.1.6 with user patch `enableContinuableTasks: true`; this is config/composition intent, not proof of plugin activation, provider capability, or live lifecycle. The separate `desktop` profile bundles the experimental team profile; active desktop was not modified. The plugin lifecycle suite uses mocked DSH services, plus a focused test of RC2 option-resolution/descriptor helpers; neither it nor profile composition establishes live provider, persistence, cold-resume, or tool-policy parity. Removing the package does not remove session history.

## Parity ledger

This project is staged. The following are working or deferred, not claims that the upstream product has been fully recreated.

| Capability area | Status in this milestone |
| --- | --- |
| One-shot and opt-in continuable specialist tasks | DSH-managed; direct children expose running/inactive residency, but no completion status, plugin-origin proof, result polling, or TTL |
| Ultrawork workflow, packaged skills, and slash commands | Prompt-level task steering and reusable DSH skills only; upstream keyword hooks, plan execution, and recovery remain missing |
| Per-role model selection | Static provider/model/reasoning/token overrides; DSH clears inherited reasoning on route change unless specified; no category/model chains or cross-model fallback |
| Retry/fallback | DSH handles same-route provider retries; OMO-style model fallback chains are not implemented |
| Permissions/tool scoping | DSH remains authoritative; allowTools filters inherited global tools, not a hard boundary for child-scoped registrations |
| Native Goals, todo/task tracking, Ralph loops, workflows | Left to DSH; availability follows the active profile and dsh-omo does not claim equivalent upstream behavior |
| Broader upstream skills, hooks, memory, teams, telemetry, notifications, browser/MCP, LSP | Not yet implemented as OMO-compatible adapters; the desktop-only DSH team bundle is not dsh-omo integration |
| Durable task controls, background dashboard, persistent DAG, advanced recovery | Label-matched continuable children expose DSH residency only and can be interrupted; no completion status, result polling, TTL, quotas, dashboard, or task DAG |
| Full agent/category roster and one-to-one command parity | Not yet implemented |

The pinned, detailed feature inventory and iterative acceptance loop are in [docs/feature-parity.md](docs/feature-parity.md). Its audit is ongoing; no missing row is silently treated as out of scope.

## License and attribution

This independent implementation uses public DSH extension APIs and is licensed under MIT. It is inspired by published workflow concepts, not copied source code, and is not affiliated with DeepSeek or the Oh My OpenCode / Oh My OpenAgent maintainers.
