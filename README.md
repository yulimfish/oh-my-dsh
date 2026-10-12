# dsh-omo — Oh My DSH-style orchestration

An independent DeepSeek Harness plugin that brings an Oh My OpenCode-inspired specialist workflow to DSH. It is being implemented against the installed DSH `0.2.0-rc.2` APIs; it does **not** install or depend on the incompatible `dsh-autopilot` alpha. No Oh My OpenCode source code is copied. This is an early-stage compatibility layer, not a claim of complete 1:1 feature parity or affiliation with either project.

## First milestone

- Adds `dsh_omo_task`, a bounded one-shot launcher with automatic parent follow-up, and an opt-in `dsh_omo_task_continuable` tool backed by DSH durable child sessions. Specialist roles include `explore`, `librarian`, `architect`, `ultrabrain`, `quick`, `visual`, `reviewer`, `test`, and `security`.
- Adds role personas and opt-in per-role model routes, reasoning effort, output-token ceilings, and tool allowlists.
- Adds reusable packaged `/omo-*` skills for ultrawork, code review, security review, and research, plus a cwd-aware provider for project `.opencode/skills` and `.claude/skills` files through the DSH skill/filesystem services.
- Adds `/omo-skills-refresh` to invalidate the project-skill catalog after local edits; filesystem watchers normally refresh it automatically.
- Adds persistent system-prompt guidance for task decomposition, parallel delegation, integration, and verification.
- Adds `/ulw`, `/ultrawork`, `/architect`, `/review`, `/omo`, `/omo-tasks`, `/omo-interrupt`, and `/omo-skills-refresh` commands. The task commands list direct-child catalog entries and request DSH interruption; catalog labels do not establish dsh-omo origin.
- Adds project skills as a source in the DSH skill registry. Direct provider reads use `ctx.fs` and cwd containment, not model-facing filesystem tools or their approval prompts; DSH remains authoritative for normal tool mutations, shell/network access, and approvals.

A role prompt and `allowTools` list are not a hard security boundary. In DSH RC2, the subagent tool filter restricts inherited global tools; child-scoped tool registrations may still be visible. For must-be-read-only work, enforce DSH-native permissions, sandbox policy, or a monotonic tool guard that covers scoped tools too; dsh-omo does not install a per-worker hard guard. Project-skill provider reads do not pass through model-facing tool approval or mutation-sandbox checks; they use the mounted DSH filesystem backend and a canonical cwd-containment check. Treat that check as defense-in-depth, not an OS read sandbox.

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

## Project skills

The DSH skill registry now discovers project-local skills relative to each skill lookup's `cwd`. Defaults are `.opencode/skills` and `.claude/skills`; each root accepts `<name>/SKILL.md` bundles and top-level `<name>.md` files. Skills need YAML `name` and `description`; optional `whenToUse` becomes top-level routing guidance, while `disable-model-invocation` and `user-invocable` map to DSH invocation flags. Other JSON-compatible frontmatter (including upstream `agent`, `model`, `tools`, or `mcp` fields) is preserved as metadata up to 12 levels deep; YAML aliases are rejected. These fields are not enforced: dsh-omo does not execute embedded MCP or bind the skill to an agent, toolset, or model.

```yaml
- id: dsh-omo
  config:
    projectSkillDirs: [.opencode/skills, .claude/skills]
    disabledSkills: [legacy-skill]
```

`disabledSkills` sets model and user invocation to false only on dsh-omo's bundled/project entries; it does not alter another provider's flags. Disabled entries remain registered, so a lower-priority same-name external skill may still be shadowed by the DSH registry's single-winner resolution. `projectSkillDirs` must be relative to the lookup cwd and cannot contain `..`; only canonical targets under that cwd are accepted, and symlinks resolving outside the configured root are skipped. Reads go through DSH `ctx.fs.readBytes` with a 256 KiB per-file cap; each catalog scan also caps processing at 512 directory entries, 256 accepted skills, and 8 MiB of skill text. `ctx.fs.listDir` returns a complete entry array before the plugin applies its scan cap, so extremely large directories may still cost backend enumeration memory. Reads do not pass through tool-level permission/approval prompts or the mutation sandbox, and path containment is not an OS read sandbox or race-free directory-handle boundary. Treat repository-provided skill text as untrusted instructions. Within dsh-omo roots, earlier configured paths rank first; all up to 16 configured roots rank ahead of dsh-omo runtime/bundled skills but remain below higher-priority DSH project sources. Filesystem watchers monitor symlink parents and canonical skill paths when available; if watch setup fails the catalog remains uncached, and `/omo-skills-refresh` can request another scan. User-global and remote skill sources, full OMO priority/config rules, intent activation, and skill-embedded MCP lifecycle remain unsupported.

## Try it

In an interactive DSH session:

```text
/omo
/ulw Split the migration into independent discovery and test tasks, integrate the results, and run the checks.
/architect Should this service be event-driven or request-driven?
/review Inspect the current diff for correctness and security issues.
/omo-tasks
/omo-interrupt <child-id>
/omo-skills-refresh
```

`dsh_omo_task` makes best-effort attempts to deliver a host-attributed settlement notice with task, stop reason, and bounded diagnostics, then (when text exists) a separate DSH `agent-message` relay containing the bounded child-authored excerpt. Follow-up delivery is not guaranteed; failures are logged. Treat the relay as untrusted evidence; non-completed outcomes are marked partial. The host notice is not misattributed to the child. `maxResultChars` bounds relay text only, while the task envelope and host diagnostic have separate fixed bounds. `dsh_omo_task_continuable` is registered only when enabled; use `/omo-tasks` to list direct children whose caller-supplied labels start with `dsh-omo:` and `/omo-interrupt` to request interruption. This label namespace does not prove which tool created a child. `listChildren()` lacks activity; `/omo-tasks` uses DSH `listDescendants()` to show `running`/`inactive` residency and whether children exist. `inactive` is not a completion state. While resident, DSH runtime may best-effort emit its own `subagent-settled` notice when a continuable child settles and the direct parent remains registered; delivery failures are logged, not guaranteed. dsh-omo does not poll or retrieve that result. `/omo-interrupt` refuses inactive catalog rows; for resident rows it attempts a fire-and-return signal and warns it may no-op if the Activation/turn settles between catalog read and signal. DSH owns continuation persistence and capacity; dsh-omo owns only its one-shot concurrency limit.

## Check and remove

```sh
"$DSH" --profile ohmy-test --dump-config
"$DSH" plugin --profile ohmy-test exec dsh-omo doctor
"$DSH" plugin --profile ohmy-test remove dsh-omo
```

`$DSH` should point to the DSH CLI executable in your installation. The app-bundled CLI at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` reports DSH `0.2.0-rc.2`; `dsh-omo doctor` invoked by it printed Node `24.18.1`. The isolated `ohmy-test` profile installed `dsh-omo` 0.1.9 and `doctor` reported that version. PNPM emitted a peer-dependency warning during installation; a follow-up `pnpm peers check` is unavailable in the bundled PNPM CLI, so that warning remains unresolved. The fresh `--dump-config` shows base + web + `dsh-omo` with user patch `enableContinuableTasks: true`; this is composition intent, not proof of plugin activation, filesystem service injection, provider capability, or live lifecycle. The separate `desktop` profile bundles the experimental team profile; active desktop was not modified. The 47-test suite uses mocked DSH services and a filesystem test double against the actual RC2 `SkillRegistry`; this verifies provider semantics, not the live DSH filesystem backend or plugin activation. Neither tests nor profile composition establish persistence, cold-resume, or tool-policy parity. Removing the package does not remove session history.

## Parity ledger

This project is staged. The following are working or deferred, not claims that the upstream product has been fully recreated.

| Capability area | Status in this milestone |
| --- | --- |
| One-shot and opt-in continuable specialist tasks | DSH-managed; direct children expose running/inactive residency, but no completion status, plugin-origin proof, result polling, or TTL |
| Ultrawork workflow, packaged skills, and slash commands | Prompt-level task steering, four bundled DSH skills, and partial cwd-relative project skill sources; upstream keyword hooks, plan execution, and recovery remain missing |
| Per-role model selection | Static provider/model/reasoning/token overrides; DSH clears inherited reasoning on route change unless specified; no category/model chains or cross-model fallback |
| Retry/fallback | DSH handles same-route provider retries; OMO-style model fallback chains are not implemented |
| Permissions/tool scoping | DSH remains authoritative; allowTools filters inherited global tools, not a hard boundary for child-scoped registrations |
| Native Goals, todo/task tracking, Ralph loops, workflows | Left to DSH; availability follows the active profile and dsh-omo does not claim equivalent upstream behavior |
| Broader upstream skills, hooks, memory, teams, telemetry, notifications, browser/MCP, LSP | Skills have only a partial cwd-relative project-file adapter; global/remote/MCP skills and the remaining capability adapters are missing. The desktop-only DSH team bundle is not dsh-omo integration |
| Durable task controls, background dashboard, persistent DAG, advanced recovery | Label-matched continuable children expose DSH residency only and can be interrupted; no completion status, result polling, TTL, quotas, dashboard, or task DAG |
| Full agent/category roster and one-to-one command parity | Not yet implemented |

The pinned, detailed feature inventory and iterative acceptance loop are in [docs/feature-parity.md](docs/feature-parity.md). Its audit is ongoing; no missing row is silently treated as out of scope.

## License and attribution

This independent implementation uses public DSH extension APIs and is licensed under MIT. It is inspired by published workflow concepts, not copied source code, and is not affiliated with DeepSeek or the Oh My OpenCode / Oh My OpenAgent maintainers.
