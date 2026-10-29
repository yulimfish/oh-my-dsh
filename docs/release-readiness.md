# Usable-today release guide

## Scope and release decision

**dsh-omo 0.1.14 is the source candidate covered by this guide**, targeting DSH `0.2.1-rc.3` and Node 24+. This version statement is not an installation claim. Check the intended Profile's live Plugin Manager inventory, Config and behavior before identifying its active version. Machine-specific test counts, artifact digests and installation/smoke events belong in the separate [deployment record](<deployment-record.md>), whose entries are time-bound, not universal guarantees.

The acceptance target is **OpenCode plugin-edition behavior**, not the whole Native/Senpi application. Canonical `model_profile` lanes control Native/Senpi main-session startup; child role chains are not those lanes. This package remains a bounded partial adapter, not complete parity, a restart-resumable task engine, or a new permission boundary. Review upstream's [Sustainable Use License](https://github.com/code-yeongyu/oh-my-openagent/blob/e50fc64a26f35ea07ceab26a8f23e8853fd2c4d6/LICENSE.md) before copying source or curated tables; do not assume MIT terms.

## Start conservatively

The shipped [bundle patch](<../cordis.patch.yml>) uses one-shot delegation, four concurrent children, depth one and inherited model defaults; optional surfaces remain off. Start with that baseline or use this **optional complete replacement config** for its existing `dsh-omo` row. This example is not an additional insertion or a deep merge, and this guide does not apply it:

```yaml
- id: dsh-omo
  name: dsh-omo
  config:
    provider: spawn
    maxConcurrent: 2
    maxDepth: 1
    maxTaskChars: 12000
    maxResultChars: 8000
    enableTaskResultTool: true
    enableTaskWaitTool: true
    enableTaskCancelTool: true
    enableTaskResultPersistence: false
    enableContinuableTasks: false
    enableContinuableTaskFollowups: false
    enableProjectAgentFiles: false
    enableGoalTools: false
    enableTeamTools: false
    projectSkillDirs: [.opencode/skills, .claude/skills, .agents/skills]
    disabledSkills: []
    models: {}
    categoryRoutes: []
    roleRoutes: []
    userAgents: []
```

Other optional flags default off in [Config](<../src/index.js>). Avoid copying old flags wholesale. In untrusted repositories use `projectSkillDirs: []`: project skills are untrusted guidance and plugin-level filesystem reads do not pass through model-facing read approvals. Bundled skills remain available.

- `spawn` is the DSH **subagent provider**, not an LLM provider. Confirm its registration. Empty role/category routes avoid guessed model IDs and cross-provider routing; verify an actual inherited-route child call.
- Concurrency saturation rejects immediately by default. Optional `maxPendingTasks` (1–16) waits inside the original Tool call for global capacity with an eight-second monotonic deadline, subject to event-loop scheduling; route saturation still rejects, and no pending child ID or durable queue is created. Queued role/task/category/agentFile/distinct explicitly requested skill names are limited to 32,768 UTF-16 code units. Depth bounds delegation, not model turns, total spend or wall time.
- Result tracking exposes `dsh_omo_task_list`/`dsh_omo_task_result`. Wait requires tracking; tracking requires Cordis `ctx.on`/`ctx.effect`; wait additionally requires `tools.register`; cancel requires `subagents.interrupt`, `tools.register` and `ctx.effect`. Start without these opt-ins if prerequisites are absent.
- Cached results are bounded and exact-live-Agent-owned; terminal results normally expire after 30 minutes. Without persistence, unload/restart loses them, and a new Agent after compaction may not own the old cache. They are not durable task history.
- Wait defaults to eight seconds, maximum 30. Timeout/caller cancellation ends only the wait. Cancel requests fire-and-return interruption; acceptance is not proof the child stopped. These tools do not address arbitrary sessions or generic jobs.

## Optional foreground and skill format adapters (0.1.14)

`enableForegroundTaskTool: true` exposes `dsh_omo_task_join` using the normal task arguments and shared route/skill/admission path. It waits up to eight seconds after startup within the Host call deadline. Terminal text is bounded untrusted evidence; otherwise it returns the real running child ID. Native final-result acknowledgement prevents duplicate relays and honors Host result-policy vetoes. Cancellation after accepted startup stops waiting without requesting child interruption; native parent lifetime still applies. It requires live exact-Agent lookup and lifecycle/final-result events, supports at most 64 pending acknowledgements and is not a durable/queued task engine. Existing async delegation is unchanged and caching stays separately opt-in.

`enableProjectSkillFormatCompatibility: true` permits plain Markdown, absent-only metadata defaults and directory-named Markdown fallback when canonical `SKILL.md` is absent. Explicit invalid metadata still rejects. Existing containment, size/version checks, root selection and link policy remain; uncertain truncated listings do not select a fallback, and canonical-file appearance invalidates stale fallback lookups. This does not enable recursive namespaces, new roots, MCP or skill-frontmatter agent/model execution. Both flags default off; additional skill-catalog context is opt-in.

## Optional exact model catalog and chains

Candidate 0.1.13 adds a bounded, user-authored `models` catalog for **primary role/category routes and fallback entries**. It does not discover providers or supply builtin model tables. Use only exact provider/model routes approved to receive the task data; this example's placeholders must be replaced with verified routes:

```yaml
models:
  fast: { model: approved-provider/vendor/exact-model-id, reasoning: medium }
  backup: { model: approved-backup-provider/exact-model-id }
roleRoutes:
  - role: explore
    model: fast
    reasoningEffort: high
    fallbackModels: [{ model: backup }]
```

Here the role's explicit `high` overrides catalog `medium`. Declare every referenced alias and verify that the selected real model supports the requested effort.

Rules and boundaries:

1. Catalog size is at most 64 entries; aliases are ASCII names beginning with a letter, at most 64 characters, with letters/digits/underscore/dot/hyphen thereafter. Reserved prototype keys, unknown fields and malformed values reject. The pure normalizer additionally rejects symbols/accessors; the native Loader is not a hostile-JavaScript sandbox. Each value has only `model: provider/model` and optional `reasoning`; provider ≤128 characters, model tail ≤256, reasoning ≤64, nonempty and control/bidi-free. Split at the **first** slash preserves an exact model tail containing further slashes. Targets must be fully qualified, never recursive aliases.
2. Expand a known model-only alias only when `provider` is omitted. An explicit provider/model pair is literal, even if the model text equals an alias. Unknown/unqualified references remain subject to existing paired-route validation; there is no guessed provider or default rescue.
3. Catalog reasoning fills only an unset `reasoningEffort`. Explicit use-site reasoning wins; blank/null values are not silently treated as missing. Expansion precedes optional role/category route aliases and fallback duplicate checks, so aliases resolving to the same effective pair reject as duplicates.
4. Explicit category selection takes precedence over a role's default category, while an explicit role primary pair and role reasoning/token controls override category values. A pinned role's own fallback chain supersedes the category chain; a pinned role without its own chain does not inherit the category fallback chain.
5. A fallback-only role may provide 1–3 explicit candidates (including declared catalog references) with no primary or category. Any explicit/default category mixing rejects. Candidates use one aggregate five-second capability-preflight budget; all failures reject without implicit parent/system fallback. Ordinary pinned role/category chains retain their documented preflight behavior. Candidate reasoning/token precedence remains use-site-controlled; catalog values do not override explicit settings.
6. Preflight uses exact Host `llm.resolveCallConfig`, not fuzzy matching, catalog availability, credential probing or a reserved dispatch. It may succeed before a later model call fails. No parent route, main-session model or Profile is automatically changed. Default-off `runtimeFallback` is a separate feature, not implied by catalog or spawn-time chains.

## Known modern-Host limitations

The inspected Host contract exposes `subagents.startActivation`, `getProvider`, `listDescendants`, `sendMessage` and `interrupt`; its request supports `agentPreset`, prompt content, `agentOptions`, `outputSchema` and `maxDepth`, but **no per-request persona/toolFilter**, and no legacy `startContinuable` creation method. Reinspect the target runtime rather than assuming all future Hosts are identical.

- Keep continuable/follow-up and project-agent-file flags false on this contract. Native Host durable children do not make this plugin's legacy adapter compatible.
- Do not configure prompt-based `userAgents`, role allow/deny filters or category tool maps expecting enforcement. Persona setup or selected filtered launches fail closed. Prompt wording is not read-only authorization; child-scoped tools and reserved transports also need native policy coverage.
- Existing trusted presets are a later opt-in only if the chosen provider advertises `agentPreset`; this package does not create them. Preset preflight is not a permission boundary or composition-revision pin.
- Keep persistence, extra context/rule adapters, runtime fallback/recovery, pruning, terminals, vision and image persistence off until separately accepted. Never send private data to an unapproved fallback provider.
- Filesystem containment/version checks are not atomic no-follow read guarantees. Bounded session output does not establish bounded Host log-loading time/memory. Native Teams/Goals/jobs/persistence may be useful independently, but their existence does not prove this package activates or duplicates them.

Shared catalog/default-chain behavior remains a subset. Malformed pre-dispatch argument repair, live config/prompt reload and Skill MCP lifecycle remain partial or absent. Broader monorepo features require edition-by-edition validation before being counted as OpenCode requirements. See the [parity ledger](<feature-parity.md>); extra flags and test counts do not establish complete parity.

## Reproduce source and package checks

From the repository root with existing dependencies and Node 24+:

```sh
node --version
pnpm run check
pnpm test
pnpm run test:tool-outputs
node src/doctor.js --json
node src/doctor.js --json --dsh-version 0.2.1-rc.2
git diff --check
```

Use the managed Node/pnpm paths returned by the runtime dependency tool if PATH selects different versions. `check` already includes the unit suite; `test` explicitly repeats it. The [output audit](<../scripts/audit-tool-outputs.mjs>) checks successful **exercised** Tool results/renderers, not every branch, real endpoint or visual layout. Doctor's supplied DSH version is caller-reported, not live introspection; without it runtime compatibility is unverified.

In an authorized build step, pack (`pnpm pack --pack-destination .artifacts`), inspect the actual file list and [manifest](<../package.json>), record the SHA-256, and run extracted-package checks with declared dependency provenance. Include runtime modules, patch, tests/scripts/docs, locale resources and icon. A matching version or existing tarball is not proof it contains the current source, installs, activates or passes a real model call. Rendered Plugin Manager artwork needs its own visual verification.

## Authorized activation and rollback

**Do not hand-edit Profile files or use shell/package-manager commands to install, upgrade or select Profile bundles.** `plugin_manager` owns installation/selection; every action requires suitable permission or approval. Instructions here grant neither. Changes affect every session in the selected Profile.

1. List bundles/plugins through `plugin_manager` to obtain exact identifiers and detect previous overrides. Listing uses the same permission checks.
2. With explicit authorization, call `install_bundle` with the absolute reviewed package directory/artifact. Prefer a reviewed artifact for reproducibility; directory installation links mutable source. Do not install an incompatible autopilot alpha.
3. Do not preapprove install scripts. If `pendingBuilds` is returned, get explicit permission for those exact packages before passing `approvedBuilds`. Never grant a runtime-version exemption without informed approval for the exact pair; a mismatch rejection is not successful installation.
4. Apply any approved full config override through the normal configuration workflow or a reviewed configuration-only bundle. Remove incompatible higher-priority overrides, especially legacy continuation flags. Never assume this guide's optional config was applied.
5. Read `application`, warnings and `nextStep`. Failed, overridden or restart-required outcomes are not live success. Follow the actual restart/application instruction; new bundles and upgrades can differ. Saved package inventory alone does not establish a fresh running module generation.
6. Query Host `Config.listConfigs({name: 'dsh-omo'})`, then the exact returned entry's schema. Check intended-Agent `Tool.listTools` for the task Tool and chosen opt-ins. A composed config dump, package version or tarball is not activation evidence.
7. Smoke-test the target GUI/Profile below. Roll back only with authorized `set_bundle`/`set_plugin` or `remove_bundle` using exact listed identifiers. Removal does not undo child edits, external side effects or stored data.

## Ten-minute live smoke acceptance

Use a disposable workspace with normal DSH permission/sandbox protections. Do not start a replacement server to simulate activation.

1. Run `/omo status` for setup-time flags/service presence and `/omo status capabilities` for advertised capabilities/provider IDs. Neither proves endpoint health or credentials.
2. Launch one tiny `explore` task: “Identify the package test command; do not edit; return evidence.” Verify child identity, actual terminal settlement and parent relay. Read-only wording is advisory, not enforcement.
3. If enabled, list/read that same Agent's tracked result; exercise a short wait on a controlled longer task and verify timeout does not cancel the child. Interrupt only a disposable child and distinguish request acceptance from actual settlement. `/omo-tasks` inactive means residency/activity, not completion or plugin origin.
4. Run two harmless independent tasks, integrate findings and run a real repository test. For trusted skill use, invoke one exact available model-invocable skill; refresh after edits only if separately authorized.
5. If catalog/chains are configured, verify the selected exact route and controls on the target runtime separately; an inherited-route smoke does not certify optional fallback behavior. Restore any test state.

Append version/runtime, artifact digest, effective Config, actual Tool presence, child IDs/stop reasons, relays, failures and verification limits to a time-bound deployment event. **Only the actual target's successful checks justify calling that deployment live-ready.**
