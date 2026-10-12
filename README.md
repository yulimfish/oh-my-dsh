# dsh-omo — Oh My DSH-style orchestration

An independent DeepSeek Harness plugin that brings an Oh My OpenCode-inspired specialist workflow to DSH. It is being implemented against the installed DSH `0.2.0-rc.2` APIs; it does **not** install or depend on the incompatible `dsh-autopilot` alpha. No Oh My OpenCode source code is copied. This is an early-stage compatibility layer, not a claim of complete 1:1 feature parity or affiliation with either project.

## First milestone

- Adds `dsh_omo_task`, a bounded, background subagent launcher with specialist roles: `explore`, `librarian`, `architect`, `ultrabrain`, `quick`, `visual`, `reviewer`, `test`, and `security`.
- Adds role personas and opt-in per-role model routes, reasoning effort, output-token ceilings, and tool allowlists.
- Adds reusable packaged `/omo-*` skills for ultrawork, code review, security review, and research.
- Adds persistent system-prompt guidance for task decomposition, parallel delegation, integration, and verification.
- Adds `/ulw`, `/ultrawork`, `/architect`, `/review`, and `/omo` slash commands.
- Does not override DSH's native permission, approval, sandbox, credential, Goal, workflow, Ralph, skill, or session-storage policy.

A role prompt is not a security boundary. If a task must be read-only, configure an explicit `allowTools` list for that role; the DSH native policy still applies to every tool call.

## Install in an isolated profile

Build a local package tarball, then add it to a dedicated profile:

```sh
cd oh-my-dsh
pnpm install
pnpm run check
pnpm pack --pack-destination .artifacts

# Create/seed a separate profile from the shipped web template, then add the tarball.
dsh --profile ohmy --from-default-profile web --dump-config
dsh plugin --profile ohmy add .artifacts/dsh-omo-0.1.3.tgz
dsh --profile ohmy --dump-config
```

The user-facing app should be restarted after adding the package. Test the isolated profile first; only add it to `desktop` after reviewing the effective configuration.

## Configure roles

The package installs a bundle row in `cordis.patch.yml`. Add entries to its `roleRoutes` list to select an approved model and, optionally, a least-privilege tool allowlist for a role:

```yaml
- id: dsh-omo
  name: dsh-omo
  config:
    provider: spawn
    maxConcurrent: 4
    maxDepth: 1
    maxTaskChars: 12000
    maxResultChars: 8000
    roleRoutes:
      - role: explore
        provider: deepseek-official
        model: deepseek-flash
        reasoningEffort: medium
        maxTokens: 4096
        allowTools: [read, glob, grep, web_search, web_fetch]
```

`provider` and `model` must be set together. The provider/model must already be registered in the profile; DSH rejects unavailable routes. When a route is omitted, a child inherits the parent's route. `allowTools` is opt-in because tool names vary by profile; DSH validates the names and enforces the restriction when the worker starts. DSH's own provider retry policy handles request failures; this plugin does not override it. DSH `0.2.0-rc.2` workers inherit the parent workspace; this plugin does not promise a separate child `cwd`.

## Try it

In an interactive DSH session:

```text
/omo
/ulw Split the migration into independent discovery and test tasks, integrate the results, and run the checks.
/architect Should this service be event-driven or request-driven?
/review Inspect the current diff for correctness and security issues.
```

The parent agent receives each worker's bounded result as a follow-up when that one-shot run settles and remains responsible for integration and verification. Workers and returned text are capped per plugin instance; DSH also applies its global subagent capacity and delegation-depth rules.

## Check and remove

```sh
"$DSH" --profile ohmy --dump-config
"$DSH" plugin --profile ohmy exec dsh-omo doctor
"$DSH" plugin --profile ohmy remove dsh-omo
```

`$DSH` should point to the DSH CLI executable in your installation. Removing the package does not remove session history.

## Parity ledger

This project is staged. The following are working or deferred, not claims that the upstream product has been fully recreated.

| Capability area | Status in this milestone |
| --- | --- |
| Specialist roles and background delegation | Implemented on DSH's managed subagent API |
| Ultrawork workflow, packaged skills, and explicit slash commands | Implemented as task steering, reusable DSH skills, and persistent guidance |
| Per-role model selection | Static per-role override; otherwise inherit the parent model |
| Retry/fallback | Delegated to DSH's provider retry policy; no OMO-specific fallback chains yet |
| Permissions/tool scoping | DSH remains authoritative; explicit role allowlists are supported |
| Native Goals, todo/task tracking, Ralph loops, workflows | Left to DSH; profile enablement and parity have not yet been audited |
| Broader upstream skills, hooks, memory, notifications, browser/MCP, LSP | Not yet implemented as OMO-compatible adapters |
| Background task dashboard, persistent DAG, advanced recovery | Not yet implemented |
| Full agent/category roster and one-to-one command parity | Not yet implemented |

The pinned, detailed feature inventory and iterative acceptance loop are in [docs/feature-parity.md](docs/feature-parity.md). Its audit is ongoing; no missing row is silently treated as out of scope.

## License and attribution

This independent implementation uses public DSH extension APIs and is licensed under MIT. It is inspired by published workflow concepts, not copied source code, and is not affiliated with DeepSeek or the Oh My OpenCode / Oh My OpenAgent maintainers.
