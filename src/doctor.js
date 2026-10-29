#!/usr/bin/env node

import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const expectedDsh = manifest.peerDependencies['@deepseek-ai/dsh-subagent']
const nodeRequirement = manifest.engines.node
const minimumNodeMajor = Number(/^>=(\d+)$/u.exec(nodeRequirement)?.[1])
if (!Number.isSafeInteger(minimumNodeMajor)) throw new Error('Unsupported manifest Node.js requirement')
const nodeMajor = Number(process.versions.node.split('.')[0])
const args = process.argv.slice(2)
const json = args.includes('--json')
let suppliedDshVersion
let argumentError
let seenJson = false
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--json' && !seenJson) {
    seenJson = true
  } else if (arg === '--dsh-version' && suppliedDshVersion === undefined) {
    const value = args[++index]
    if (typeof value !== 'string' || value.trim() !== value || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(value)) {
      argumentError = `--dsh-version requires an explicit version such as ${expectedDsh}`
      break
    }
    suppliedDshVersion = value
  } else {
    argumentError = 'Unknown or duplicate argument. Usage: dsh-omo [--json] [--dsh-version <version>]'
    break
  }
}

if (argumentError) {
  if (json) console.log(JSON.stringify({ error: argumentError }, null, 2))
  else console.error(argumentError)
  process.exitCode = 2
} else {
  const report = {
    plugin: manifest.name,
    pluginVersion: manifest.version,
    expectedDsh,
    dshVersion: suppliedDshVersion ?? null,
    dshVersionSource: suppliedDshVersion === undefined ? 'unverified' : 'explicit-argument',
    compatibleDsh: suppliedDshVersion === undefined ? null : suppliedDshVersion === expectedDsh,
    node: process.versions.node,
    compatibleNode: Number.isInteger(nodeMajor) && nodeMajor >= minimumNodeMajor,
    notes: [
      'The installed DSH runtime was not queried; --dsh-version checks only the version supplied by the caller.',
      'This is an independent, early-stage DSH plugin inspired by documented Oh My OpenCode workflows.',
      'It does not change DSH permission, approval, sandbox, or credential policy; project-skill reads call ctx.fs directly and bypass tool-level read prompts.',
      'Run `dsh --profile <name> --dump-config` after installation to verify the bundle is composed.',
    ],
  }
  if (!report.compatibleNode || report.compatibleDsh === false) process.exitCode = 1
  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`${report.plugin} ${report.pluginVersion}`)
    console.log(`Target DSH: ${expectedDsh}`)
    console.log(suppliedDshVersion === undefined
      ? 'Installed DSH runtime: unverified (check with dsh --version)'
      : `Supplied DSH version: ${suppliedDshVersion} — ${report.compatibleDsh ? 'matches target' : 'does not match target'} (explicit argument, not runtime introspection)`)
    console.log(`Node.js: ${report.node} — ${report.compatibleNode ? 'supported' : `requires Node.js ${nodeRequirement}`}`)
    for (const note of report.notes) console.log(`- ${note}`)
  }
}
