window.__ModuleLoader__.load({
  id: 'dsh-omo',
  factory(require) {
    const React = require('react')
    const host = require('host')
    const h = React.createElement
    const { useEffect, useState } = React
    const KEYS = [
      ['enableFocusChain', 'Focus Chain', 'Re-read the active native Goal at prompt assembly to keep the objective visible.'],
      ['enableRepeatedCallAdvisory', 'Repeated Call Advisory', 'Warn after repeated identical completed tool calls without blocking legitimate retries.'],
      ['enableProgressContext', 'Progress Context', 'Recover the latest successful todo list from the native session log after compaction.'],
      ['enableGoalCompletionReview', 'Goal Completion Review', 'Run one bounded completion review before ending a turn with an active Goal.'],
      ['enableVerifyCommand', 'Verify Command', 'Enable /omo verify to inspect project scripts and observed bash evidence without running tests.'],
      ['enableTaskHandoffCommand', 'Task Handoff Command', 'Enable /omo handoff for explicit new-task recovery from failed or incomplete specialist results.'],
    ]
    const styles = {
      page: { maxWidth: 880, padding: '24px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)' },
      title: { margin: '0 0 8px', fontSize: 22, fontWeight: 650 },
      intro: { margin: '0 0 20px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.55 },
      list: { display: 'grid', gap: 12 },
      card: { display: 'flex', alignItems: 'flex-start', gap: 14, padding: 16, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)' },
      label: { flex: 1, cursor: 'pointer' },
      name: { display: 'block', fontWeight: 600, marginBottom: 5 },
      description: { display: 'block', color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.5 },
      checkbox: { width: 18, height: 18, marginTop: 2, accentColor: 'var(--dsw-alias-brand-primary)' },
      dependency: { padding: 14, marginBottom: 18, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', fontSize: 13 },
      status: { marginTop: 16, color: 'var(--dsw-alias-label-secondary)', minHeight: 22 },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      button: { marginTop: 14, padding: '7px 12px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', cursor: 'pointer' },
    }
    function SettingsPage() {
      const [values, setValues] = useState(null)
      const [status, setStatus] = useState('Loading settings…')
      const [error, setError] = useState(false)
      const [busy, setBusy] = useState(false)
      useEffect(() => {
        let active = true
        host.call('read').then(result => {
          if (!active) return
          if (result?.found) setValues(result.values)
          else setStatus('The dsh-omo plugin is not installed in this profile.')
          setStatus('')
        }).catch(() => {
          if (active) { setError(true); setStatus('Could not read long-horizon settings.') }
        })
        return () => { active = false }
      }, [])
      async function change(key, value) {
        if (busy || !values) return
        setBusy(true); setError(false); setStatus('Saving…')
        try {
          const result = await host.call('update', { [key]: value })
          if (result?.found) { setValues(result.values); setStatus('Saved. All other dsh-omo settings were preserved.') }
          else setStatus('The dsh-omo plugin is not installed in this profile.')
        } catch {
          setError(true); setStatus('Could not save this setting. No change was confirmed.')
        } finally { setBusy(false) }
      }
      if (!values) return h('section', { style: styles.page }, h('p', { style: styles.status }, status))
      return h('section', { style: styles.page },
        h('h1', { style: styles.title }, 'Long-horizon tasks'),
        h('p', { style: styles.intro }, 'Optional DSH-native mechanisms for long-running work. Every feature is off by default. Changes are saved through the normal plugin configuration lifecycle; no second task or objective store is created.'),
        h('div', { style: styles.dependency },
          h('strong', null, 'Handoff prerequisite: '),
          'Task Result Tool is enabled automatically when Handoff is enabled. Disabling it also disables Handoff. ',
          h('button', { type: 'button', style: styles.button, disabled: busy, onClick: () => change('enableTaskResultTool', !values.enableTaskResultTool) },
            values.enableTaskResultTool ? 'Disable Task Result Tool' : 'Enable Task Result Tool')),
        h('div', { style: styles.list }, KEYS.map(([key, title, description]) => h('div', { key, style: styles.card },
          h('input', { id: `long-horizon-${key}`, type: 'checkbox', style: styles.checkbox, checked: values[key] === true, disabled: busy, onChange: event => change(key, event.target.checked) }),
          h('label', { htmlFor: `long-horizon-${key}`, style: styles.label },
            h('span', { style: styles.name }, title),
            h('span', { style: styles.description }, description))))),
        h('p', { style: { ...styles.status, ...(error ? styles.error : {}) }, role: 'status' }, status))
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab', id: 'long-horizon', order: 20, label: 'Long-horizon',
        }, SettingsPage))
      },
    }
  },
})
