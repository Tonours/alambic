import fs from 'node:fs'
import path from 'node:path'
import { readSchema, validateData } from '../lib/frontmatter.mjs'

const root = process.argv[2]
const schema = readSchema(root)
const cases = JSON.parse(fs.readFileSync(path.join(root, '_meta/tests/fixtures/frontmatter-cases.json'), 'utf8'))
let failed = 0
for (const fixture of cases) {
  const errors = validateData(fixture.data, schema, { strict: true })
  if ((errors.length === 0) !== fixture.valid) {
    process.stderr.write(`schema fixture failed: ${fixture.name}\n`)
    failed += 1
  }
}
process.stdout.write(`schema fixtures: ${cases.length - failed}/${cases.length}\n`)
if (failed) process.exitCode = 1

const { validateVault } = await import('../lib/vault.mjs')
const os = await import('node:os')
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-supersession-'))
for (const dir of ['kb', 'ref', 'docs', '_meta']) fs.mkdirSync(path.join(vault, dir))
for (const file of ['CLAUDE.md', 'AGENTS.md', 'README.md']) fs.writeFileSync(path.join(vault, file), '# fixture\n')
fs.copyFileSync(path.join(root, '_meta/note.schema.json'), path.join(vault, '_meta/note.schema.json'))
const note = (status, extra = '') => `---\ntype: finding\nstatus: ${status}\n${extra}summary: "Supersession fixture note"\nsources:\n  - "https://example.org/supersession"\ncreated: 2026-09-23\nupdated: 2026-09-23\ntags:\n  - fixture\n---\n\n# Fixture\n`
function supersessionErrors({ stub, index }) {
  fs.writeFileSync(path.join(vault, 'kb/successor.md'), note('verified'))
  fs.writeFileSync(path.join(vault, 'kb/draft-target.md'), note('draft'))
  fs.writeFileSync(path.join(vault, 'kb/stub.md'), stub)
  fs.writeFileSync(path.join(vault, 'kb/_index.md'), `# Index\n\n${index.map((name) => `- [[${name}]]`).join('\n')}\n`)
  return validateVault(vault, { strict: true }).errors.filter((error) => error.field === 'superseded_by' || error.field === 'index')
}
const supersessionCases = [
  ['valid stub', supersessionErrors({ stub: note('superseded', 'superseded_by: successor\n'), index: ['successor', 'draft-target'] }), 0],
  ['missing successor', supersessionErrors({ stub: note('superseded'), index: ['successor', 'draft-target'] }), 1],
  ['inactive successor', supersessionErrors({ stub: note('superseded', 'superseded_by: draft-target\n'), index: ['successor', 'draft-target'] }), 1],
  ['stub listed in index', supersessionErrors({ stub: note('superseded', 'superseded_by: successor\n'), index: ['successor', 'draft-target', 'stub'] }), 1],
]
fs.rmSync(vault, { recursive: true, force: true })
for (const [name, errors, expected] of supersessionCases) {
  if (errors.length !== expected) {
    process.stderr.write(`supersession fixture failed: ${name} (${errors.length} errors, expected ${expected})\n`)
    process.exitCode = 1
  }
}
process.stdout.write(`supersession fixtures: ${supersessionCases.length}\n`)
