window.__ModuleLoader__.load({
  id: 'dsh-omo',
  factory(require) {
    const React = require('react')
    const host = require('host')
    const h = React.createElement
    const { useEffect, useRef, useState } = React
    const LOCALE_NAMESPACE = 'dsh-omo.long-horizon'
    const REFRESH_INTERVAL = 10_000
    const MAX_TREE_DEPTH = 32

    const translations = {
      en: {
        nav: 'Long-horizon',
        pageTitle: 'Long-horizon tasks',
        pageIntro: 'Optional DSH-native support for long-running work. These settings use the normal plugin configuration lifecycle; the Agent map below is a read-only snapshot and does not create a second task or objective store.',
        settingsHeading: 'Feature settings',
        settingsReadLoading: 'Loading settings…',
        settingsReadError: 'Could not read long-horizon settings.',
        pluginMissing: 'The dsh-omo plugin is not installed in this profile.',
        handoffDependency: 'Handoff requires Task Result Tool. Enabling Handoff enables its prerequisite automatically; disabling Task Result Tool also disables Handoff.',
        saving: 'Saving…',
        saved: 'Saved. Other dsh-omo settings were preserved.',
        saveError: 'Could not save this setting. No change was confirmed.',
        settingsUnavailable: 'Settings are unavailable until the dsh-omo plugin is installed.',
        focusTitle: 'Focus Chain',
        focusDescription: 'Re-read the active native Goal at prompt assembly so the objective stays visible.',
        repeatedTitle: 'Repeated Call Advisory',
        repeatedDescription: 'Warn after repeated identical completed tool calls without blocking legitimate retries.',
        progressTitle: 'Progress Context',
        progressDescription: 'Recover the latest successful todo list from the native session log after compaction.',
        reviewTitle: 'Goal Completion Review',
        reviewDescription: 'Run one bounded completion review before ending a turn with an active Goal.',
        verifyTitle: 'Verify Command',
        verifyDescription: 'Enable /omo verify to inspect project scripts and observed bash evidence without running tests.',
        handoffTitle: 'Task Handoff Command',
        handoffDescription: 'Enable /omo handoff for explicit new-task recovery from failed or incomplete specialist results.',
        taskResultTitle: 'Task Result Tool',
        taskResultDescription: 'Record explicit specialist task outcomes for handoff and review.',
        goalToolsTitle: 'Goal Tools',
        goalToolsDescription: 'Expose native Goal get/create/update tools to the exact calling Agent; DSH owns durable Goal state.',
        compactionTitle: 'Compaction Resume Advisory',
        compactionDescription: 'Add fixed per-step guidance after compaction; it does not rewrite summaries or restore other task state.',
        agentMapHeading: 'Live Agent map',
        agentMapIntro: 'A read-only, bounded view of current root Agents, their native Goal phase/objective, and descendant activity. Prompt and result bodies are not shown.',
        scopeCaveat: 'Scope: current live root Agents and the bounded descendant metadata reported for them. This is not an all-history or completion inventory.',
        idleCaveat: 'Inactive means no resident DSH Session was observed; it does not encode completion, success, or external-process state.',
        refresh: 'Refresh map',
        refreshing: 'Refreshing…',
        treeLoading: 'Loading the live Agent map…',
        treeError: 'Could not load the live Agent map.',
        treeRefreshError: 'Could not refresh the map; showing the last available snapshot.',
        treeUnavailable: 'The live Agent map is not available right now.',
        treeScopeUnavailable: 'The Host returned an unsupported map scope; no Agent details are shown.',
        noRoots: 'No current live root Agents were reported.',
        truncated: 'The Host truncated this snapshot to its configured live-root limits; this is only a partial view.',
        rootAgent: 'Root Agent',
        unavailableRoot: 'Descendant details for this root are unavailable.',
        goalLabel: 'Native Goal',
        goalPhase: 'Phase: {phase}',
        phaseActive: 'Active',
        phasePaused: 'Paused',
        phaseBlocked: 'Blocked',
        phaseComplete: 'Complete',
        goalPhaseMissing: 'Goal phase is not available.',
        goalObjective: 'Objective',
        noGoal: 'No native Goal is recorded for this root.',
        descendants: 'Descendants',
        noDescendants: 'No descendants are listed for this root.',
        agent: 'Agent',
        agentId: 'ID: {id}',
        mode: 'Mode: {mode}',
        activityRunning: 'Running',
        activityInactive: 'Not resident / inactive',
        activityUnknown: 'Activity unavailable',
        hasChildren: 'The Host reports additional descendants; some may be outside this bounded snapshot.',
        diagnostic: 'Diagnostic',
        diagnosticReason: 'Reason: {reason}',
        limitsHeading: 'Snapshot limits',
        limitMaxRoots: 'Maximum live roots',
        limitMaxDescendants: 'Maximum descendants per root',
        limitsUnavailable: 'No limit details were provided.',
        snapshotNote: 'Host note: {note}',
        updatedAt: 'Updated: {time}',
        depthLimit: 'Additional nesting was omitted to keep this view bounded.',
      },
      zh: {
        nav: '长时任务',
        pageTitle: '长时任务',
        pageIntro: '为长时间运行的工作提供可选 DSH 原生支持。设置通过常规插件配置生命周期保存；下方 Agent 图是只读快照，不会创建第二套任务或目标存储。',
        settingsHeading: '功能设置',
        settingsReadLoading: '正在读取设置…',
        settingsReadError: '无法读取长时任务设置。',
        pluginMissing: '当前配置中未安装 dsh-omo 插件。',
        handoffDependency: '任务交接依赖 Task Result Tool。启用任务交接时会自动启用此前置项；关闭 Task Result Tool 也会同时关闭任务交接。',
        saving: '正在保存…',
        saved: '已保存，其他 dsh-omo 设置保持不变。',
        saveError: '无法保存此设置，尚未确认有任何更改。',
        settingsUnavailable: '安装 dsh-omo 插件后才能使用这些设置。',
        focusTitle: 'Focus Chain（目标持续聚焦）',
        focusDescription: '在提示词组装时重新读取当前原生 Goal，使目标保持可见。',
        repeatedTitle: '重复调用提示',
        repeatedDescription: '在相同工具调用连续成功后发出提醒，但不阻止合理重试。',
        progressTitle: '进度上下文',
        progressDescription: '压缩后从原生会话日志恢复最近一次成功的待办列表。',
        reviewTitle: 'Goal 完成检查',
        reviewDescription: '当前回合结束前，对仍处于活动状态的 Goal 执行一次有界完成检查。',
        verifyTitle: 'Verify 命令',
        verifyDescription: '启用 /omo verify，在不运行测试的情况下检查项目脚本和已观察到的 bash 证据。',
        handoffTitle: '任务交接命令',
        handoffDescription: '启用 /omo handoff，以便针对失败或未完成的专家结果显式恢复为新任务。',
        taskResultTitle: '任务结果工具（Task Result Tool）',
        taskResultDescription: '记录明确的专家任务结果，供任务交接与复核使用。',
        goalToolsTitle: 'Goal 工具',
        goalToolsDescription: '向当前调用 Agent 提供原生 Goal 查询、创建和更新工具；持久化 Goal 状态由 DSH 管理。',
        compactionTitle: '压缩后续行提示',
        compactionDescription: '压缩后添加固定的逐步指导；不会重写摘要或恢复其他任务状态。',
        agentMapHeading: '实时 Agent 图',
        agentMapIntro: '只读且有界地展示当前根 Agent、其原生 Goal 阶段/目标和后代活动状态。不展示提示词或结果正文。',
        scopeCaveat: '范围：当前存活的根 Agent，以及 Host 报告的有界后代元数据。此图不是完整历史记录，也不代表任务完成状态。',
        idleCaveat: '未活动表示未观察到驻留的 DSH Session；不编码任务完成或成功状态，也不反映外部进程状态。',
        refresh: '刷新 Agent 图',
        refreshing: '正在刷新…',
        treeLoading: '正在读取实时 Agent 图…',
        treeError: '无法读取实时 Agent 图。',
        treeRefreshError: '无法刷新 Agent 图；当前显示上一次可用的快照。',
        treeUnavailable: '实时 Agent 图暂不可用。',
        treeScopeUnavailable: 'Host 返回了不支持的图范围，因此不显示 Agent 详情。',
        noRoots: '当前没有报告存活的根 Agent。',
        truncated: 'Host 已按配置的实时根节点限制截断此快照；当前仅为部分视图。',
        rootAgent: '根 Agent',
        unavailableRoot: '此根节点的后代详情暂不可用。',
        goalLabel: '原生 Goal',
        goalPhase: '阶段：{phase}',
        phaseActive: '活动',
        phasePaused: '已暂停',
        phaseBlocked: '已阻塞',
        phaseComplete: '已完成',
        goalPhaseMissing: 'Goal 阶段不可用。',
        goalObjective: '目标',
        noGoal: '此根节点没有记录原生 Goal。',
        descendants: '后代 Agent',
        noDescendants: '此根节点没有列出后代 Agent。',
        agent: 'Agent',
        agentId: 'ID：{id}',
        mode: '模式：{mode}',
        activityRunning: '运行中',
        activityInactive: '未观察到驻留会话',
        activityUnknown: '活动状态不可用',
        hasChildren: 'Host 报告了更多后代节点；其中一些可能未包含在此有界快照中。',
        diagnostic: '诊断信息',
        diagnosticReason: '原因：{reason}',
        limitsHeading: '快照限制',
        limitMaxRoots: '最大存活根 Agent 数',
        limitMaxDescendants: '每个根 Agent 的最大后代数',
        limitsUnavailable: '未提供限制详情。',
        snapshotNote: 'Host 说明：{note}',
        updatedAt: '更新时间：{time}',
        depthLimit: '为保持视图有界，已省略更深层的节点。',
      },
    }

    const settings = [
      ['enableFocusChain', 'focusTitle', 'focusDescription'],
      ['enableRepeatedCallAdvisory', 'repeatedTitle', 'repeatedDescription'],
      ['enableProgressContext', 'progressTitle', 'progressDescription'],
      ['enableGoalCompletionReview', 'reviewTitle', 'reviewDescription'],
      ['enableVerifyCommand', 'verifyTitle', 'verifyDescription'],
      ['enableTaskHandoffCommand', 'handoffTitle', 'handoffDescription'],
      ['enableTaskResultTool', 'taskResultTitle', 'taskResultDescription'],
      ['enableGoalTools', 'goalToolsTitle', 'goalToolsDescription'],
      ['enableCompactionResumeAdvisory', 'compactionTitle', 'compactionDescription'],
    ]

    const styles = {
      page: { maxWidth: 960, margin: '0 auto', padding: 24, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)' },
      title: { margin: '0 0 8px', fontSize: 22, fontWeight: 650 },
      intro: { margin: '0 0 22px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.55 },
      section: { marginTop: 28 },
      sectionTitle: { margin: '0 0 8px', fontSize: 17, fontWeight: 650 },
      sectionIntro: { margin: '0 0 16px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      list: { display: 'grid', gap: 10 },
      card: { display: 'flex', alignItems: 'flex-start', gap: 14, padding: 15, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 9, background: 'var(--dsw-alias-bg-layer-1)' },
      checkbox: { width: 18, height: 18, flex: '0 0 auto', margin: '2px 0 0', accentColor: 'var(--dsw-alias-brand-primary)' },
      label: { flex: 1, cursor: 'pointer' },
      settingName: { display: 'block', marginBottom: 4, fontWeight: 600 },
      description: { display: 'block', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.5 },
      dependency: { margin: '0 0 12px', padding: 12, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.5 },
      status: { margin: '12px 0 0', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      button: { padding: '7px 12px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', cursor: 'pointer' },
      buttonRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 },
      caveat: { margin: '0 0 10px', padding: 12, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.5 },
      warning: { margin: '10px 0', color: 'var(--dsw-alias-state-warn-primary)', lineHeight: 1.5 },
      mapStatus: { margin: '10px 0', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      rootList: { display: 'grid', gap: 12, margin: 0, padding: 0, listStyle: 'none' },
      rootCard: { padding: 16, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 9, background: 'var(--dsw-alias-bg-layer-1)' },
      rootTitle: { margin: 0, fontSize: 15, fontWeight: 650, overflowWrap: 'anywhere' },
      rootGoal: { marginTop: 12, padding: 12, borderRadius: 7, background: 'var(--dsw-alias-bg-layer-2)' },
      fieldLabel: { display: 'block', marginBottom: 4, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontWeight: 600 },
      fieldValue: { margin: 0, lineHeight: 1.5, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' },
      nodeSectionTitle: { margin: '16px 0 8px', fontSize: 13, fontWeight: 600 },
      treeList: { display: 'grid', gap: 8, margin: 0, paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l1)', listStyle: 'none' },
      treeNode: { minWidth: 0 },
      nodeCard: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 11px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 7, background: 'var(--dsw-alias-bg-layer-2)' },
      nodeMain: { display: 'grid', gap: 3, minWidth: 0, overflowWrap: 'anywhere' },
      nodeName: { fontWeight: 600 },
      nodeMeta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, overflowWrap: 'anywhere' },
      badge: { flex: '0 0 auto', padding: '3px 7px', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-1)', fontSize: 12, fontWeight: 600 },
      running: { color: 'var(--dsw-alias-state-success-primary)' },
      inactive: { color: 'var(--dsw-alias-state-idle-primary)' },
      unknown: { color: 'var(--dsw-alias-label-secondary)' },
      diagnostic: { color: 'var(--dsw-alias-state-warn-primary)' },
      diagnosticReason: { margin: '6px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.45, overflowWrap: 'anywhere' },
      nested: { marginTop: 8 },
      limits: { margin: '10px 0 0', paddingLeft: 20, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.5 },
      note: { margin: '10px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere' },
    }

    function interpolate(translate, key, values) {
      let message = translate(key)
      if (typeof message !== 'string') message = key
      for (const [name, value] of Object.entries(values || {})) {
        message = message.split(`{${name}}`).join(String(value))
      }
      return message
    }

    function textValue(value, maxLength = 240) {
      if (typeof value !== 'string' && typeof value !== 'number') return ''
      const text = String(value)
      return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
    }

    function phaseLabel(phase, tr) {
      const key = {
        active: 'phaseActive',
        paused: 'phasePaused',
        blocked: 'phaseBlocked',
        complete: 'phaseComplete',
      }[phase]
      return key ? tr(key) : phase
    }

    function limitEntries(limits, tr) {
      if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return []
      const translatedKeys = {
        maxRoots: 'limitMaxRoots',
        maxDescendantsPerRoot: 'limitMaxDescendants',
      }
      return Object.entries(limits)
        .filter(([key, value]) => !/(prompt|result|body|content)/i.test(key) && (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string'))
        .map(([key, value]) => [translatedKeys[key] ? tr(translatedKeys[key]) : textValue(key, 80), textValue(value, 120)])
    }

    function createSettingsPage(locale, translate) {
      return function SettingsPage() {
        const [, setLocaleRevision] = useState(0)
        const [values, setValues] = useState(null)
        const [settingsState, setSettingsState] = useState('loading')
        const [saveState, setSaveState] = useState('')
        const [saving, setSaving] = useState(false)
        const [treeState, setTreeState] = useState({ kind: 'loading', snapshot: null })
        const [treeRefreshKey, setTreeRefreshKey] = useState(0)
        const [refreshing, setRefreshing] = useState(false)
        const mounted = useRef(false)
        const savingRef = useRef(false)
        const treeRequestInFlight = useRef(false)
        const tr = (key, params) => interpolate(translate, key, params)

        useEffect(() => {
          mounted.current = true
          return () => { mounted.current = false }
        }, [])

        useEffect(() => {
          const unsubscribe = locale.subscribe(() => setLocaleRevision(revision => revision + 1))
          return () => { if (typeof unsubscribe === 'function') unsubscribe() }
        }, [locale])

        useEffect(() => {
          let active = true
          host.call('read').then(result => {
            if (!active) return
            if (result?.found) {
              setValues(result.values || {})
              setSettingsState('ready')
            } else {
              setSettingsState('missing')
            }
          }).catch(() => {
            if (active) setSettingsState('error')
          })
          return () => { active = false }
        }, [])

        useEffect(() => {
          let active = true
          let timer = null
          const refresh = async () => {
            if (!active) return
            if (treeRequestInFlight.current) {
              timer = setTimeout(refresh, 1000)
              return
            }
            treeRequestInFlight.current = true
            if (mounted.current) setRefreshing(true)
            try {
              const snapshot = await host.call('readAgentTree')
              if (active) {
                if (snapshot && typeof snapshot === 'object') setTreeState({ kind: 'ready', snapshot })
                else setTreeState(previous => ({ kind: 'error', snapshot: previous.snapshot }))
              }
            } catch {
              if (active) setTreeState(previous => ({ kind: 'error', snapshot: previous.snapshot }))
            } finally {
              treeRequestInFlight.current = false
              if (active && mounted.current) {
                setRefreshing(false)
                timer = setTimeout(refresh, REFRESH_INTERVAL)
              }
            }
          }
          refresh()
          return () => {
            active = false
            if (timer !== null) clearTimeout(timer)
          }
        }, [treeRefreshKey])

        async function change(key, value) {
          if (!values || savingRef.current) return
          const changes = { [key]: value }
          if (key === 'enableTaskHandoffCommand' && value === true) changes.enableTaskResultTool = true
          if (key === 'enableTaskResultTool' && value === false) changes.enableTaskHandoffCommand = false
          savingRef.current = true
          setSaving(true)
          setSaveState('saving')
          try {
            const result = await host.call('update', changes)
            if (!mounted.current) return
            if (result?.found) {
              setValues(result.values || {})
              setSaveState('saved')
            } else {
              setSettingsState('missing')
              setSaveState('missing')
            }
          } catch {
            if (mounted.current) setSaveState('error')
          } finally {
            savingRef.current = false
            if (mounted.current) setSaving(false)
          }
        }

        function renderDescendants(root) {
          const descendants = Array.isArray(root.descendants)
            ? root.descendants.filter(node => node && typeof node === 'object' && (node.kind === 'child' || node.kind === 'diagnostic'))
            : []
          const entries = descendants.map((node, index) => ({ node, index, key: `${node.kind}-${String(node.id ?? 'unknown')}-${index}` }))
          const byParent = new Map()
          for (const entry of entries) {
            const parentKey = String(entry.node.parentId ?? '')
            const children = byParent.get(parentKey) || []
            children.push(entry)
            byParent.set(parentKey, children)
          }
          const rendered = new Set()

          function renderEntry(entry, depth, ancestors) {
            if (rendered.has(entry.key)) return null
            rendered.add(entry.key)
            const node = entry.node
            const diagnostic = node.kind === 'diagnostic'
            const id = textValue(node.id, 160)
            const identity = id || entry.key
            const cycle = ancestors.has(identity)
            const nextAncestors = new Set(ancestors)
            nextAncestors.add(identity)
            const nestedEntries = !diagnostic && node.hasChildren === true && !cycle && depth < MAX_TREE_DEPTH
              ? renderBranch(node.id, depth + 1, nextAncestors)
              : []
            const activity = node.activity === 'running' ? 'running' : node.activity === 'inactive' ? 'inactive' : 'unknown'
            const label = diagnostic ? tr('diagnostic') : textValue(node.label, 120) || id || tr('agent')
            const meta = []
            if (!diagnostic && id) meta.push(tr('agentId', { id }))
            if (!diagnostic && node.mode != null) meta.push(tr('mode', { mode: textValue(node.mode, 80) }))
            const badgeStyle = diagnostic ? styles.diagnostic : activity === 'running' ? styles.running : activity === 'inactive' ? styles.inactive : styles.unknown
            const badgeText = diagnostic ? tr('diagnostic') : activity === 'running' ? tr('activityRunning') : activity === 'inactive' ? tr('activityInactive') : tr('activityUnknown')
            return h('li', { key: entry.key, style: styles.treeNode },
              h('div', { style: styles.nodeCard },
                h('div', { style: styles.nodeMain },
                  h('span', { style: styles.nodeName }, label),
                  meta.map((item, index) => h('span', { key: `${entry.key}-meta-${index}`, style: styles.nodeMeta }, item))),
                h('span', { style: { ...styles.badge, ...badgeStyle } }, badgeText)),
              diagnostic && node.reason != null
                ? h('p', { style: styles.diagnosticReason }, tr('diagnosticReason', { reason: textValue(node.reason, 240) }))
                : null,
              !diagnostic && node.hasChildren === true && nestedEntries.length === 0
                ? h('p', { style: styles.diagnosticReason }, depth >= MAX_TREE_DEPTH ? tr('depthLimit') : tr('hasChildren'))
                : null,
              nestedEntries.length > 0 ? h('ul', { style: { ...styles.treeList, ...styles.nested } }, nestedEntries) : null)
          }

          function renderBranch(parentId, depth, ancestors) {
            const branch = byParent.get(String(parentId ?? '')) || []
            return branch.map(entry => renderEntry(entry, depth, ancestors)).filter(Boolean)
          }

          let tree = renderBranch(root.id, 0, new Set([String(root.id ?? '')]))
          const orphaned = entries.filter(entry => !rendered.has(entry.key))
          if (orphaned.length) {
            tree = tree.concat(orphaned.map(entry => renderEntry(entry, 0, new Set([String(root.id ?? '')]))).filter(Boolean))
          }
          return tree
        }

        const snapshot = treeState.snapshot
        const roots = snapshot && Array.isArray(snapshot.roots) ? snapshot.roots.filter(root => root && typeof root === 'object') : []
        const limits = snapshot ? limitEntries(snapshot.limits, tr) : []
        const scopeIsLiveRoots = snapshot?.scope === 'live-roots'
        let saveMessage = ''
        if (saveState === 'saving') saveMessage = tr('saving')
        else if (saveState === 'saved') saveMessage = tr('saved')
        else if (saveState === 'error') saveMessage = tr('saveError')
        else if (saveState === 'missing') saveMessage = tr('pluginMissing')
        const settingsNotice = settingsState === 'loading'
          ? tr('settingsReadLoading')
          : settingsState === 'error'
            ? tr('settingsReadError')
            : settingsState === 'missing'
              ? tr('settingsUnavailable')
              : ''

        return h('main', { style: styles.page, 'aria-labelledby': 'long-horizon-title' },
          h('h1', { id: 'long-horizon-title', style: styles.title }, tr('pageTitle')),
          h('p', { style: styles.intro }, tr('pageIntro')),
          h('section', { style: styles.section, 'aria-labelledby': 'long-horizon-settings-heading' },
            h('h2', { id: 'long-horizon-settings-heading', style: styles.sectionTitle }, tr('settingsHeading')),
            settingsState === 'ready'
              ? h(React.Fragment, null,
                h('p', { style: styles.dependency }, tr('handoffDependency')),
                h('div', { style: styles.list }, settings.map(([key, titleKey, descriptionKey]) => {
                  const id = `long-horizon-${key}`
                  return h('div', { key, style: styles.card },
                    h('input', {
                      id,
                      type: 'checkbox',
                      style: styles.checkbox,
                      checked: values[key] === true,
                      disabled: saving,
                      'aria-describedby': `${id}-description`,
                      onChange: event => change(key, event.target.checked),
                    }),
                    h('label', { htmlFor: id, style: styles.label },
                      h('span', { style: styles.settingName }, tr(titleKey)),
                      h('span', { id: `${id}-description`, style: styles.description }, tr(descriptionKey))))
                })),
                saveMessage ? h('p', { style: { ...styles.status, ...(saveState === 'error' ? styles.error : {}) }, role: saveState === 'error' ? 'alert' : 'status', 'aria-live': 'polite' }, saveMessage) : null)
              : h('p', { style: { ...styles.status, ...(settingsState === 'error' ? styles.error : {}) }, role: settingsState === 'error' ? 'alert' : 'status' }, settingsNotice)),
          h('section', { style: styles.section, 'aria-labelledby': 'long-horizon-map-heading' },
            h('div', { style: styles.buttonRow },
              h('h2', { id: 'long-horizon-map-heading', style: styles.sectionTitle }, tr('agentMapHeading')),
              h('button', { type: 'button', style: styles.button, onClick: () => setTreeRefreshKey(key => key + 1), 'aria-busy': refreshing }, refreshing ? tr('refreshing') : tr('refresh'))),
            h('p', { style: styles.sectionIntro }, tr('agentMapIntro')),
            h('p', { style: styles.caveat }, tr('scopeCaveat')),
            h('p', { style: styles.caveat }, tr('idleCaveat')),
            treeState.kind === 'loading' && !snapshot
              ? h('p', { style: styles.mapStatus, role: 'status' }, tr('treeLoading'))
              : null,
            treeState.kind === 'error'
              ? h('p', { style: { ...styles.warning, ...(snapshot ? {} : styles.error) }, role: 'alert' }, tr(snapshot ? 'treeRefreshError' : 'treeError'))
              : null,
            snapshot?.truncated === true
              ? h('p', { style: styles.warning, role: 'status' }, tr('truncated'))
              : null,
            snapshot && !scopeIsLiveRoots
              ? h('p', { style: { ...styles.warning, ...styles.error }, role: 'alert' }, tr('treeScopeUnavailable'))
              : null,
            snapshot && scopeIsLiveRoots && snapshot.available !== true
              ? h('p', { style: styles.mapStatus, role: 'status' }, tr('treeUnavailable'))
              : null,
            snapshot && scopeIsLiveRoots && snapshot.available === true
              ? roots.length === 0
                ? h('p', { style: styles.mapStatus, role: 'status' }, tr('noRoots'))
                : h('ul', { style: styles.rootList, 'aria-label': tr('agentMapHeading') }, roots.map((root, index) => {
                  const rootId = textValue(root.id, 160) || `#${index + 1}`
                  const goal = root.goal && typeof root.goal === 'object' ? root.goal : null
                  const phase = goal ? textValue(goal.phase, 100) : ''
                  const objective = goal ? textValue(goal.objective, 10000) : ''
                  const unavailable = Boolean(root.unavailable)
                  const children = Array.isArray(root.descendants) ? root.descendants.filter(node => node && typeof node === 'object' && (node.kind === 'child' || node.kind === 'diagnostic')) : []
                  return h('li', { key: `${rootId}-${index}`, style: styles.rootCard },
                    h('h3', { style: styles.rootTitle }, `${tr('rootAgent')}: ${rootId}`),
                    unavailable
                      ? h('p', { style: { ...styles.mapStatus, ...styles.warning }, role: 'status' }, tr('unavailableRoot'))
                      : null,
                    goal
                      ? h('div', { style: styles.rootGoal },
                        h('span', { style: styles.fieldLabel }, tr('goalLabel')),
                        h('p', { style: styles.fieldValue }, phase ? tr('goalPhase', { phase: phaseLabel(phase, tr) }) : tr('goalPhaseMissing')),
                        objective ? h('div', { style: { marginTop: 10 } },
                          h('span', { style: styles.fieldLabel }, tr('goalObjective')),
                          h('p', { style: styles.fieldValue }, objective)) : null)
                      : h('p', { style: styles.mapStatus }, tr('noGoal')),
                    unavailable
                      ? null
                      : h(React.Fragment, null,
                        h('h4', { style: styles.nodeSectionTitle }, tr('descendants')),
                        children.length === 0
                          ? h('p', { style: styles.mapStatus }, tr('noDescendants'))
                          : h('ul', { style: styles.treeList, 'aria-label': tr('descendants') }, renderDescendants(root))))
                }))
              : null,
            snapshot && scopeIsLiveRoots && limits.length > 0
              ? h('div', null,
                h('h3', { style: styles.nodeSectionTitle }, tr('limitsHeading')),
                h('ul', { style: styles.limits }, limits.map(([key, value], index) => h('li', { key: `${key}-${index}` }, `${key}: ${value}`))))
              : snapshot && scopeIsLiveRoots && snapshot.limits
                ? h('p', { style: styles.mapStatus }, tr('limitsUnavailable'))
                : null,
            snapshot && typeof snapshot.note === 'string' && snapshot.note.trim()
              ? h('p', { style: styles.note }, tr('snapshotNote', { note: textValue(snapshot.note.trim(), 300) }))
              : null,
            snapshot && typeof snapshot.updatedAt === 'number' && Number.isFinite(snapshot.updatedAt)
              ? h('p', { style: styles.note }, tr('updatedAt', { time: new Date(snapshot.updatedAt).toLocaleString() }))
              : null))
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale')
        const translate = locale.bind(LOCALE_NAMESPACE)
        ctx.effect(() => {
          const disposeEnglish = locale.register(LOCALE_NAMESPACE, 'en', translations.en)
          const disposeChinese = locale.register(LOCALE_NAMESPACE, 'zh', translations.zh)
          return () => {
            if (typeof disposeChinese === 'function') disposeChinese()
            if (typeof disposeEnglish === 'function') disposeEnglish()
          }
        })
        const SettingsPage = createSettingsPage(locale, translate)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'long-horizon', order: 25, label: () => translate('nav'),
        }, SettingsPage))
      },
    }
  },
})
