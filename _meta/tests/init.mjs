#!/usr/bin/env node
// `alambic init` scaffolds only the publishable set: private patterns, the
// live plan, and runtime caches never ship; repo tooling (.github) does.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
const root = path.resolve(process.argv[2] || '.')
const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-init-')), 'vault')
try {
  const run = spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), 'init', dest], { encoding: 'utf8' })
  assert(run.status === 0, `init failed: ${run.stderr}`)
  const ignored = new Set(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n'))
  const missingIgnore = fs.readFileSync(path.join(root, '_meta/templates/gitignore'), 'utf8').split('\n').filter((line) => line && !line.startsWith('#') && !ignored.has(line))
  assert(missingIgnore.length === 0, `.gitignore lacks _meta/templates/gitignore entries: ${missingIgnore.join(', ')}`)
  for (const rel of ['.github/workflows/ci.yml', '.gitignore', 'package.json', 'npm-shrinkwrap.json', '_meta/alambic.mjs', 'kb/_index.md', 'ref/home.md']) {
    assert(fs.existsSync(path.join(dest, rel)), `init missing ${rel}`)
  }
  for (const rel of ['.leak-patterns', 'PLAN.md', '.git', 'node_modules', '.workflow', '_meta/.cache']) {
    assert(!fs.existsSync(path.join(dest, rel)), `init copied non-publishable ${rel}`)
  }
  // No-git fallback (zip/tarball copy): staging and private markers still stay out.
  fs.writeFileSync(path.join(dest, 'docs/inbox/ai/attention-digest-test.md'), 'personal\n')
  fs.writeFileSync(path.join(dest, '.leak-patterns'), 'x\n')
  fs.rmSync(path.join(dest, '.gitignore'))
  const copy = `${dest}-copy`
  const fallback = spawnSync(process.execPath, [path.join(dest, '_meta/alambic.mjs'), 'init', copy], { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dest) } })
  assert(fallback.status === 0, `fallback init failed: ${fallback.stderr}`)
  for (const rel of ['docs/inbox/ai/attention-digest-test.md', '.leak-patterns']) assert(!fs.existsSync(path.join(copy, rel)), `fallback init copied ${rel}`)
  for (const rel of ['docs/inbox/README.md', 'docs/inbox/ai/.gitkeep', '.github/workflows/ci.yml', '.gitignore', 'npm-shrinkwrap.json']) assert(fs.existsSync(path.join(copy, rel)), `fallback init missing ${rel}`)
  const again = spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), 'init', dest], { encoding: 'utf8' })
  assert(again.status !== 0, 'init must refuse a non-empty destination without --force')

  const bin = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).bin.alambic
  const binDir = path.join(path.dirname(dest), 'node_modules/.bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.symlinkSync(path.join(root, bin), path.join(binDir, 'alambic'))
  const viaBin = spawnSync(path.join(binDir, 'alambic'), ['init', `${dest}-bin`], { encoding: 'utf8' })
  assert(viaBin.status === 0 && fs.existsSync(path.join(`${dest}-bin`, 'kb/_index.md')), `init via bin symlink failed: ${viaBin.stderr}`)

  const home = path.join(path.dirname(dest), 'home')
  const stubs = path.join(path.dirname(dest), 'stubs')
  fs.mkdirSync(stubs)
  fs.writeFileSync(path.join(stubs, 'npm'), `#!/bin/sh\nmkdir node_modules && ln -s '${path.join(root, 'node_modules')}'/* '${path.join(root, 'node_modules')}'/.bin node_modules/\n`, { mode: 0o755 })
  const installed = `${dest}-installed`
  const isolated = { PATH: `${stubs}${path.delimiter}${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local/state') }
  const full = spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), 'init', installed, '--install', '--harness', 'pi', '--no-shim'], { encoding: 'utf8', env: isolated })
  assert(full.status === 0, `init --install failed: ${full.stdout}${full.stderr}`)
  assert(fs.existsSync(path.join(installed, '.obsidian')), 'init --install skipped the Obsidian bootstrap')
  const skill = fs.readFileSync(path.join(home, '.agents/skills/alambic/SKILL.md'), 'utf8')
  assert(skill.includes(fs.realpathSync(installed)), 'init --install must point setup at the new vault (physical path)')
  assert(/alambic doctor: ok/.test(full.stdout), 'init --install must finish with a passing doctor')
  const extra = spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), 'init', `${dest}-extra`, '--harness', 'pi'], { encoding: 'utf8' })
  assert(extra.status !== 0, 'init must reject setup options without --install')
  console.log('init: ok')
} finally {
  fs.rmSync(path.dirname(dest), { recursive: true, force: true })
}
