import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AGENT_PROMPT,
  checkObsidianBootstrap,
  listStagedMarkdown,
  resolveStagedRoots,
  validateVault,
} from '../lib/vault.mjs'

const root = process.argv[2] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const errors = []

function check(name, fn) {
  try {
    fn()
  } catch (error) {
    errors.push(`${name}: ${error.message}`)
  }
}

check('agent-prompt mentions hybrid inbox and promotion gate', () => {
  assert.match(AGENT_PROMPT, /docs\/inbox/)
  assert.match(AGENT_PROMPT, /obsidian-hybrid-workflow/)
  assert.match(AGENT_PROMPT, /reviewed_by/)
  assert.doesNotMatch(AGENT_PROMPT, /only AGENTS\.md, CLAUDE\.md, ref\/second-brain-operating-model\.md, and kb\/_index\.md\.$/)
})

check('resolveStagedRoots fails closed on invalid ALAMBIC_STAGED', () => {
  assert.throws(
    () => resolveStagedRoots(root, { stagedEnv: path.join(os.tmpdir(), `missing-staged-${process.pid}`) }),
    /ALAMBIC_STAGED is set but is not a directory/,
  )
})

check('resolveStagedRoots prefers valid ALAMBIC_STAGED', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-staged-'))
  const note = path.join(dir, 'note.md')
  fs.writeFileSync(note, '# staged\n')
  try {
    const roots = resolveStagedRoots(root, { stagedEnv: dir })
    assert.deepEqual(roots, [path.resolve(dir)])
    const files = listStagedMarkdown(root, { stagedEnv: dir })
    assert.ok(files.some((file) => file.endsWith('note.md')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('default staged root includes docs/inbox', () => {
  const roots = resolveStagedRoots(path.resolve(root), { stagedEnv: '' })
  const expected = path.resolve(root, 'docs/inbox')
  assert.ok(roots.map((dir) => path.resolve(dir)).includes(expected), `roots=${JSON.stringify(roots)} expected=${expected}`)
})

check('versioned Obsidian defaults exist', () => {
  for (const name of ['app.json', 'core-plugins.json', 'community-plugins.json', 'templates.json', 'bookmarks.json']) {
    assert.ok(fs.existsSync(path.join(root, '_meta/obsidian/defaults', name)), name)
  }
  const core = JSON.parse(fs.readFileSync(path.join(root, '_meta/obsidian/defaults/core-plugins.json'), 'utf8'))
  assert.equal(core.bases, true)
  assert.equal(core.templates, true)
  const app = JSON.parse(fs.readFileSync(path.join(root, '_meta/obsidian/defaults/app.json'), 'utf8'))
  assert.equal(app.newFileFolderPath, 'docs/inbox/manual')
  const ignore = app.userIgnoreFilters
  assert.ok(Array.isArray(ignore), 'userIgnoreFilters missing')
  for (const pattern of [
    'docs/**/txt/**',
    'docs/**/manifest.tsv',
    'docs/**/coverage.tsv',
    'docs/**/INDEX.txt',
    'docs/inbox/ai/**',
    'docs/youtube-weekly-runs/**',
    'docs/plan/**',
    'docs/projects/**',
  ]) {
    assert.ok(ignore.includes(pattern), `missing ignore ${pattern}`)
  }
  assert.ok(
    !ignore.some((pattern) => /^(kb|ref)(\/|\*\*|$)/.test(pattern)),
    `kb/ref must stay visible, got ${JSON.stringify(ignore)}`,
  )
  assert.ok(
    !ignore.some((pattern) => /^(docs\/inbox\/manual)(\/|\*\*|$)/.test(pattern)),
    `docs/inbox/manual must stay visible, got ${JSON.stringify(ignore)}`,
  )
  const graph = JSON.parse(fs.readFileSync(path.join(root, '_meta/obsidian/defaults/graph.json'), 'utf8'))
  for (const folder of [
    'docs/inbox/ai',
    'docs/youtube-weekly-runs',
    'docs/plan',
    'docs/projects',
  ]) {
    assert.ok(String(graph.search).includes(`-path:${folder}`), `graph missing -path:${folder}`)
  }
  assert.doesNotMatch(String(graph.search), /-path:(kb|ref)(?:\s|$)/, 'graph must not hide kb/ref')
  assert.doesNotMatch(String(graph.search), /-path:docs\/inbox(?:\s|$)/, 'graph must not hide all of docs/inbox')
  assert.equal(graph.showOrphans, true, 'keep orphans so unlinked kb/ref notes stay on the graph')
})

check('bootstrap check reports installed local config when present', () => {
  const report = checkObsidianBootstrap(root)
  if (fs.existsSync(path.join(root, '.obsidian'))) {
    assert.equal(report.installed, true)
    assert.equal(report.ok, true, report.issues.join('; '))
  } else {
    assert.equal(report.installed, false)
    assert.equal(report.ok, false)
  }
})

check('promotion gate rejects verified inbox-sourced notes without review', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-gate-'))
  try {
    for (const dir of ['kb', 'ref', 'docs', '_meta']) fs.mkdirSync(path.join(tmp, dir), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'docs/inbox/ai'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'docs/inbox/ai/proposal.md'), '# proposal\n')
    fs.copyFileSync(path.join(root, '_meta/note.schema.json'), path.join(tmp, '_meta/note.schema.json'))
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'README.md']) fs.writeFileSync(path.join(tmp, name), `# ${name}\n`)
    fs.writeFileSync(path.join(tmp, 'ref/knowledge-health.base'), 'filters:\n  and:\n    - \'file.ext == "md"\'\nviews: []\n')
    fs.writeFileSync(path.join(tmp, 'kb/_index.md'), '---\ntype: reference\nstatus: verified\nupdated: 2026-07-10\ntags:\n  - index\n---\n\n# Index\n\n- [[gate-test]]\n')
    fs.writeFileSync(path.join(tmp, 'ref/method.md'), `---
type: reference
status: verified
summary: "fixture method"
created: 2026-07-10
updated: 2026-07-10
tags:
  - method
---

# method
`)
    fs.writeFileSync(path.join(tmp, 'kb/gate-test.md'), `---
type: finding
status: verified
summary: "Should fail without review metadata"
sources:
  - "docs/inbox/ai/proposal.md"
created: 2026-07-10
updated: 2026-07-10
tags:
  - hybrid
---

# gate test
`)
    const failed = validateVault(tmp, { strict: true })
    assert.equal(failed.ok, false)
    assert.ok(failed.errors.some((error) => error.field === 'reviewed_at'), JSON.stringify(failed.errors))

    fs.writeFileSync(path.join(tmp, 'kb/gate-test.md'), `---
type: finding
status: verified
summary: "Should pass with review metadata"
sources:
  - "docs/inbox/ai/proposal.md"
created: 2026-07-10
updated: 2026-07-10
reviewed_by: human
reviewed_at: 2026-07-10
promoted_from: docs/inbox/ai/proposal.md
tags:
  - hybrid
---

# gate test
`)
    const passed = validateVault(tmp, { strict: true })
    assert.equal(passed.ok, true, JSON.stringify(passed.errors, null, 2))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

if (errors.length) {
  for (const error of errors) process.stderr.write(`${error}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('hybrid-obsidian tests: ok\n')
}
