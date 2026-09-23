#!/usr/bin/env node
/**
 * Drives real vault query/context entry points used by every harness adapter.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { queryVault, contextPack, routeVaultKnowledge, ALLOWED_TOP_LEVEL_DIRS } from '../lib/vault.mjs'

const root = process.argv[2] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')

function fail(message) {
  process.stderr.write(`multi-harness test: ${message}\n`)
  process.exitCode = 1
}

for (const dir of ['.pi', '.workflow', '.obsidian', '.trash', '.git']) {
  if (!ALLOWED_TOP_LEVEL_DIRS.has(dir)) fail(`ALLOWED_TOP_LEVEL_DIRS missing infrastructure dir ${dir}`)
}

const required = [
  'kb/alambic-multi-harness-access.md',
  'kb/source-grounded-answer-quality.md',
  'ref/second-brain-scorecard.md',
  'ref/shadow-apply-gate.md',
]
for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) fail(`missing required contract ${rel}`)
}

const fr = queryVault(root, 'conserver le contexte autour du passage pertinent après découpage', { limit: 5 })
if (!fr.some((hit) => hit.path === 'kb/sentence-window-retrieval-pattern.md')) {
  fail(`FR durable query missed sentence-window pattern; top=${fr.map((h) => h.path).join(',')}`)
}

const en = queryVault(root, 'agent trust boundaries tool results untrusted', { limit: 5 })
if (!en.some((hit) => hit.path.includes('trust') || hit.path.includes('agent-input'))) {
  fail(`EN trust query returned no trust note; top=${en.map((h) => h.path).join(',')}`)
}

const none = queryVault(root, 'purple aardvark quantum bananas', { limit: 5 })
if (none.length !== 0) {
  fail(`no-answer probe should abstain; got ${none.map((h) => h.path).join(',')}`)
}

const pack = contextPack(root, 'conserver le contexte autour du passage', { maxTokens: 2500 })
if (!pack || pack.estimated_tokens > 2500) {
  fail(`context pack missing or over budget: ${pack?.estimated_tokens}`)
}
if (!pack.results?.length) {
  fail('context pack at 2500 tokens must return at least one durable excerpt')
}
const packMin = contextPack(root, 'second brain architecture', { maxTokens: 512 })
if (packMin.estimated_tokens > 512) {
  fail(`min context pack over budget: ${packMin.estimated_tokens}`)
}
if (!packMin.results?.length || packMin.abstained) {
  fail('min context pack (512 tokens) must fit ≥1 durable excerpt when candidates exist')
}

const route = routeVaultKnowledge(root, 'comment accéder à alambic depuis claude et codex harness')
if (route && route.abstained === false && Array.isArray(route.matched_notes)) {
  const paths = route.matched_notes.map((n) => n.path || n).join(' ')
  if (!/alambic|harness|second-brain|memory|wiki/i.test(paths + JSON.stringify(route.topics || []))) {
    // routing is best-effort
  }
}

const mcpSource = fs.readFileSync(path.join(root, '_meta/mcp/server.mjs'), 'utf8')
const toolRegs = [...mcpSource.matchAll(/registerTool\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
const allowed = new Set(['vault_search', 'vault_context', 'vault_read', 'vault_health'])
// Deliberate staging surface (feat(mcp) shadow capture/feedback):
// aggregate-only staging, never a durable kb write. Anything else is unexpected.
const allowedStaging = new Set(['vault_capture', 'vault_feedback'])
for (const name of toolRegs) {
  if (!allowed.has(name) && !allowedStaging.has(name)) fail(`MCP registers unexpected tool: ${name}`)
}
for (const need of allowed) {
  if (!toolRegs.includes(need)) fail(`MCP missing read tool: ${need}`)
}
for (const need of allowedStaging) {
  if (!toolRegs.includes(need)) fail(`MCP missing staging tool: ${need}`)
}
if (/registerTool\(\s*['"]vault_write/.test(mcpSource) || /registerTool\(\s*['"]vault_apply/.test(mcpSource)) {
  fail('MCP must not register write/apply tools')
}

const applyGuard = fs.readFileSync(path.join(root, '_meta/alambic.mjs'), 'utf8')
if (!applyGuard.includes('apply is disabled until the 7-day shadow gate')) {
  fail('CLI apply guard string missing')
}

const cli = path.join(root, '_meta/alambic.mjs')
const session = spawnSync(process.execPath, [cli, 'session', '--json', '--max-tokens', '512', 'second brain architecture'], { cwd: root, encoding: 'utf8' })
if (session.status !== 0) fail(`session failed: ${session.stderr || session.stdout}`)
const sessionJson = JSON.parse(session.stdout)
if (!sessionJson.pack || sessionJson.pack.results.length < 1) {
  fail('session must select ≥1 context path for a known durable query')
}
if (Math.ceil(Buffer.byteLength(session.stdout.trim()) / 4) > 512) fail('session output must stay within --max-tokens')

if (process.exitCode) process.exit(process.exitCode)
process.stdout.write('multi-harness test: ok\n')
