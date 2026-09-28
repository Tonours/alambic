#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-doctor-'))
const vault = path.join(temp, 'vault')
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALAMBIC_') && key !== 'TYPESAFE_API_KEY')), HOME: path.join(temp, 'home'), XDG_STATE_HOME: path.join(temp, 'state') }
const cli = (...args) => spawnSync(process.execPath, [path.join(vault, '_meta/alambic.mjs'), ...args], { cwd: temp, env, encoding: 'utf8' })
const day = 24 * 60 * 60 * 1000
const draft = (relative, ageDays) => {
  const file = path.join(vault, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `# ${path.basename(relative, '.md')}\n\ncapture\n`)
  const when = new Date(Date.now() - ageDays * day)
  fs.utimesSync(file, when, when)
}

try {
  const init = spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), 'init', vault], { env, encoding: 'utf8' })
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`)
  fs.cpSync(path.join(vault, '_meta/obsidian/defaults'), path.join(vault, '.obsidian'), { recursive: true })
  draft('docs/inbox/manual/fresh-capture.md', 0)
  draft('docs/inbox/manual/stale-capture.md', 20)
  draft('docs/inbox/ai/processed/rejected-old.md', 40)

  const json = cli('doctor', '--json')
  let report = {}
  try { report = JSON.parse(json.stdout) } catch { report = {} }
  check(json.status === 0 && report.ok === true, `doctor must stay green with a stale inbox (exit ${json.status}): ${json.stderr.trim()}`)
  const inbox = report.inbox || {}
  check(inbox.count === 2 && inbox.oldest_days === 20 && inbox.older_than_14_days === 1, `doctor --json inbox fields wrong: ${JSON.stringify(inbox)}`)
  check(Array.isArray(inbox.warnings) && inbox.warnings.length === 1 && /older than 14 days/.test(inbox.warnings[0]), `a stale inbox note must be a warning: ${JSON.stringify(inbox.warnings)}`)

  const text = cli('doctor')
  check(text.status === 0 && /^inbox: 2 staged, oldest 20 days, 1 older than 14 days$/m.test(text.stdout) && /^ {2}- warning: .*older than 14 days/m.test(text.stdout), `doctor text must show the inbox line and warning: ${text.stdout}`)

  fs.rmSync(path.join(vault, 'docs/inbox/manual/stale-capture.md'))
  const clean = JSON.parse(cli('doctor', '--json').stdout || '{}').inbox || {}
  check(clean.count === 1 && clean.older_than_14_days === 0 && clean.warnings?.length === 0, `a fresh inbox must report no warning: ${JSON.stringify(clean)}`)
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`doctor tests: ${failure}\n`)
  process.exit(1)
}
process.stdout.write('doctor tests: ok\n')
