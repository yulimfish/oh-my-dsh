#!/usr/bin/env node

const expectedDsh = '0.2.0-rc.2'
const minimumNodeMajor = 24
const nodeMajor = Number(process.versions.node.split('.')[0])

const report = {
  plugin: 'dsh-omo',
  pluginVersion: '0.1.4',
  expectedDsh,
  node: process.versions.node,
  compatibleNode: Number.isInteger(nodeMajor) && nodeMajor >= minimumNodeMajor,
  notes: [
    'This is an independent, early-stage DSH plugin inspired by documented Oh My OpenCode workflows.',
    'It does not change DSH permission, approval, sandbox, or credential policy.',
    'Run `dsh --profile <name> --dump-config` after installation to verify the bundle is composed.',
  ],
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`dsh-omo ${report.pluginVersion}`)
  console.log(`Target DSH: ${expectedDsh} (installed runtime: check with dsh --version)`)
  console.log(`Node.js: ${report.node} — ${report.compatibleNode ? 'supported' : `requires Node.js >=${minimumNodeMajor}`}`)
  for (const note of report.notes) console.log(`- ${note}`)
  if (!report.compatibleNode) process.exitCode = 1
}
