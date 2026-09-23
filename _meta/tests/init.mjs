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
  for (const rel of ['.github/workflows/ci.yml', '.gitignore', 'package.json', '_meta/alambic.mjs', 'kb/_index.md', 'ref/home.md']) {
    assert(fs.existsSync(path.join(dest, rel)), `init missing ${rel}`)
  }
  for (const rel of ['.leak-patterns', 'PLAN.md', '.git', 'node_modules', '.workflow', '_meta/.cache']) {
    assert(!fs.existsSync(path.join(dest, rel)), `init copied non-publishable ${rel}`)
  }
  // No-git fallback (zip/tarball copy): staging and private markers still stay out.
  fs.writeFileSync(path.join(dest, 'docs/inbox/ai/attention-digest-test.md'), 'personal\n')
  fs.writeFileSync(path.join(dest, '.leak-patterns'), 'x\n')
  const copy = `${dest}-copy`
  const fallback = spawnSync(process.execPath, [path.join(dest, '_meta/alambic.mjs'), 'init', copy], { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dest) } })
  assert(fallback.status === 0, `fallback init failed: ${fallback.stderr}`)
  for (const rel of ['docs/inbox/ai/attention-digest-test.md', '.leak-patterns']) assert(!fs.existsSync(path.join(copy, rel)), `fallback init copied ${rel}`)
  for (const rel of ['docs/inbox/README.md', 'docs/inbox/ai/.gitkeep', '.github/workflows/ci.yml']) assert(fs.existsSync(path.join(copy, rel)), `fallback init missing ${rel}`)
  const again = spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), 'init', dest], { encoding: 'utf8' })
  assert(again.status !== 0, 'init must refuse a non-empty destination without --force')
  console.log('init: ok')
} finally {
  fs.rmSync(path.dirname(dest), { recursive: true, force: true })
}
