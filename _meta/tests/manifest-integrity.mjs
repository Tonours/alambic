#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function resolveExisting(candidates) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
    const nfc = candidate.normalize('NFC')
    const nfd = candidate.normalize('NFD')
    if (fs.existsSync(nfc)) return nfc
    if (fs.existsSync(nfd)) return nfd
  }
  return null
}

const root = process.argv[2] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const manifests = []

function walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(target)
    else if (entry.name === 'manifest.tsv') manifests.push(target)
  }
}

walk(path.join(root, 'docs'))
const errors = []
let rows = 0
for (const manifest of manifests.sort()) {
  const lines = fs.readFileSync(manifest, 'utf8').trimEnd().split('\n')
  const header = lines.shift().split('\t')
  const pathColumn = header.indexOf('path')
  const hashColumn = header.indexOf('sha256')
  const archivedColumn = header.indexOf('archived')
  if (pathColumn < 0 || hashColumn < 0) {
    errors.push(`${path.relative(root, manifest)}: missing path or sha256 column`)
    continue
  }
  const seen = new Set()
  for (const [index, line] of lines.entries()) {
    const fields = line.split('\t')
    const relative = fields[pathColumn]
    const expected = fields[hashColumn]
    const archived = archivedColumn >= 0 && /^(true|1|yes)$/i.test((fields[archivedColumn] || '').trim())
    const file = resolveExisting([
      path.join(root, relative || ''),
      path.join(path.dirname(manifest), relative || ''),
    ])
    rows += 1
    if (!relative || seen.has(relative)) errors.push(`${path.relative(root, manifest)}:${index + 2}: missing or duplicate path`)
    seen.add(relative)
    // Archived compiled corpora keep provenance rows after raw txt/ removal.
    if (archived) continue
    if (!file) {
      errors.push(`${path.relative(root, manifest)}:${index + 2}: missing file ${relative}`)
      continue
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    if (actual !== expected) errors.push(`${path.relative(root, manifest)}:${index + 2}: stale sha256 for ${relative}`)
  }
}

if (errors.length) {
  for (const error of errors) process.stderr.write(`${error}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`manifest integrity: ok (${manifests.length} manifests, ${rows} rows)\n`)
}
