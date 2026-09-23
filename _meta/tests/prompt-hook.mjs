#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
const root = path.resolve(process.argv[2] || '.')
const GATE_SHA = JSON.parse(fs.readFileSync(path.join(root, '_meta/evals/held-out.freeze.json'), 'utf8')).hook_gate_sha256
const FORBIDDEN = ['retrieval-cli.mjs', 'semantic-vault.mjs', 'typesafe-judge.mjs']
const gateFile = path.join(root, '_meta/evals/hook-gate.json')
const gateSet = JSON.parse(fs.readFileSync(gateFile, 'utf8'))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alambic-hook-'))
const vault = path.join(temp, 'vault')

function runHook(hookPath, input, { format = 'claude', env = {}, keepOpen = false } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    const child = spawn(process.execPath, [hookPath, '--format', format], { env: { PATH: process.env.PATH, HOME: temp, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Number(process.hrtime.bigint() - started) / 1e6 }))
    if (keepOpen) child.stdin.write('{"prompt":')
    else child.stdin.end(input)
  })
}

function importGraph(entry) {
  const seen = new Set()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)) {
      const spec = match[1] || match[2] || match[3]
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec))
    }
  }
  walk(entry)
  return [...seen]
}

try {
  assert(crypto.createHash('sha256').update(fs.readFileSync(gateFile)).digest('hex') === GATE_SHA, 'hook-gate.json changed: re-measure the gate, then run `npm run eval:freeze`')
  assert(gateSet.positives.length >= 8 && gateSet.negatives.length >= 8, 'gate set needs at least 8 positives and 8 negatives')

  const init = spawnSync(process.execPath, [path.join(root, '_meta/alambic.mjs'), 'init', vault], { encoding: 'utf8' })
  assert(init.status === 0, `init failed: ${init.stderr}`)
  const hookPath = path.join(vault, '_meta/hooks/prompt-context.mjs')
  const hook = await import(pathToFileURL(hookPath).href)
  assert(hook.MIN_TOP_SCORE === gateSet.threshold.min_top_score, 'hook threshold drifted from the frozen gate set')
  assert([...hook.DURABLE_STATUS].join() === gateSet.threshold.durable_status.join(), 'hook durable statuses drifted from the gate set')

  const graph = importGraph(hookPath).map((file) => path.basename(file))
  for (const name of FORBIDDEN) assert(!graph.includes(name), `hook import graph reaches ${name}`)
  assert(graph.includes('vault.mjs'), 'hook must use vault.mjs')

  let transport = 0
  const originalFetch = globalThis.fetch
  const patched = [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [net, 'connect'], [net, 'createConnection']].map(([mod, key]) => {
    const original = mod[key]
    mod[key] = (...args) => { transport += 1; return original.apply(mod, args) }
    return () => { mod[key] = original }
  })
  globalThis.fetch = async () => { transport += 1; throw new Error('egress') }
  process.env.TYPESAFE_API_KEY = 'dummy-key-for-egress-test'
  let positives = 0
  let negatives = 0
  let quietNegative = null
  try {
    for (const prompt of gateSet.positives) if (await hook.buildContext(prompt, { root: vault })) positives += 1
    for (const prompt of gateSet.negatives) {
      if (await hook.buildContext(prompt, { root: vault })) negatives += 1
      else quietNegative ??= prompt
    }
  } finally {
    delete process.env.TYPESAFE_API_KEY
    globalThis.fetch = originalFetch
    for (const restore of patched) restore()
  }
  assert(transport === 0, `hook made ${transport} transport calls with a key set`)
  const rate = positives / gateSet.positives.length
  assert(rate >= gateSet.targets.min_positive_rate, `gate hit ${positives}/${gateSet.positives.length} positives`)
  assert(negatives <= gateSet.targets.max_negative_hits, `gate hit ${negatives}/${gateSet.negatives.length} negatives`)
  assert(quietNegative !== null, 'every gate negative fired: the silent-path check needs one quiet negative')

  assert(hook.shouldSkip('/review this') && hook.shouldSkip('too short') && !hook.shouldSkip('how should agents treat tools?'), 'skip rule wrong')
  assert(hook.promptFrom('not json') === '' && hook.promptFrom('{"prompt":42}') === '', 'garbage stdin must yield no prompt')
  assert(hook.gate({ abstained: false, results: [{ status: 'draft', score: 99 }] }).length === 0, 'non-durable top must not inject')
  assert(hook.gate({ abstained: false, results: [{ status: 'verified', score: hook.MIN_TOP_SCORE - 1 }] }).length === 0, 'score below threshold must not inject')
  const big = hook.renderContext([1, 2, 3].map((n) => ({ path: `kb/n${n}.md`, status: 'verified', excerpt: 'é'.repeat(4000) })), 'CANARY')
  assert(Buffer.byteLength(big) <= hook.HARD_BYTES && big.endsWith('alambic-canary: CANARY'), 'context cap or canary tail wrong')
  assert(big.startsWith(hook.HEADER), 'untrusted header missing')

  const positive = JSON.stringify({ prompt: gateSet.positives[0] })
  const claude = await runHook(hookPath, positive, { format: 'claude' })
  const additional = JSON.parse(claude.stdout).hookSpecificOutput
  assert(claude.code === 0 && additional.hookEventName === 'UserPromptSubmit' && additional.additionalContext.includes('kb/'), 'claude format wrong')
  const codex = await runHook(hookPath, positive, { format: 'codex' })
  assert(codex.code === 0 && JSON.parse(codex.stdout).hookSpecificOutput.additionalContext.startsWith(hook.HEADER), 'codex format wrong')
  const cursor = JSON.parse((await runHook(hookPath, positive, { format: 'cursor' })).stdout)
  assert(cursor.continue === true && cursor.additional_context.startsWith(hook.HEADER), 'cursor format wrong')
  const text = await runHook(hookPath, positive, { format: 'text' })
  assert(text.stdout.startsWith(hook.HEADER), 'text format wrong')
  const negative = await runHook(hookPath, JSON.stringify({ prompt: quietNegative }))
  assert(negative.code === 0 && negative.stdout === '', 'negative prompt must print nothing')

  for (const [input, format] of [['garbage', 'claude'], ['', 'claude'], [positive, 'bogus']]) {
    const result = await runHook(hookPath, input, { format })
    assert(result.code === 0 && result.stdout === '', `hook must exit 0 silently on ${format}/${input.slice(0, 8)}`)
  }
  const slow = await runHook(hookPath, '', { keepOpen: true })
  assert(slow.code === 0 && slow.ms < 3200, `hung stdin must exit 0 within 3.2 s (took ${Math.round(slow.ms)} ms)`)
  const brokenVault = path.join(temp, 'broken')
  fs.cpSync(path.join(vault, '_meta/hooks'), path.join(brokenVault, '_meta/hooks'), { recursive: true })
  fs.mkdirSync(path.join(brokenVault, '_meta/lib'), { recursive: true })
  fs.writeFileSync(path.join(brokenVault, '_meta/lib/vault.mjs'), "throw new Error('broken engine')\n")
  const broken = await runHook(path.join(brokenVault, '_meta/hooks/prompt-context.mjs'), positive)
  assert(broken.code === 0 && broken.stdout === '' && !broken.stderr.includes('broken engine'), 'engine failure must exit 0 silently')

  const canary = `alambic-canary-${crypto.randomBytes(8).toString('hex')}`
  const canaryRun = await runHook(hookPath, JSON.stringify({ prompt: `${gateSet.positives[0]} ${canary}` }), { format: 'claude' })
  assert(canaryRun.code === 0 && !canaryRun.stderr.includes(canary), 'canary prompt leaked to stderr')
  const scan = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return scan(full)
    return entry.isFile() && fs.readFileSync(full).includes(canary) ? [full] : []
  })
  const leaks = scan(temp)
  assert(!leaks.length, `canary prompt persisted in ${leaks.map((file) => path.relative(temp, file)).join(', ')}`)

  fs.rmSync(path.join(vault, '_meta/.cache'), { recursive: true, force: true })
  const cold = await runHook(hookPath, positive)
  const warm = []
  for (let i = 0; i < 20; i += 1) warm.push((await runHook(hookPath, positive)).ms)
  warm.sort((a, b) => a - b)
  const p95 = warm[Math.ceil(0.95 * warm.length) - 1]
  assert(p95 < gateSet.targets.warm_p95_ms, `warm p95 ${Math.round(p95)} ms over budget`)
  console.log(`prompt-hook: ok (gate ${positives}/${gateSet.positives.length} positives, ${negatives}/${gateSet.negatives.length} negatives; cold ${Math.round(cold.ms)} ms, warm p95 ${Math.round(p95)} ms)`)
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
