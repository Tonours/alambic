#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function main() {
  if (process.env.ALAMBIC_HARVEST_CHILD === '1') return
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : ''
  if (!transcript || !transcript.endsWith('.jsonl') || !fs.existsSync(transcript)) return
  const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const root = process.env.ALAMBIC_ROOT ? path.resolve(process.env.ALAMBIC_ROOT) : path.resolve(engine, '..')
  const child = spawn(process.execPath, [path.join(engine, 'alambic.mjs'), 'harvest', 'scan', '--session', transcript], { detached: true, stdio: 'ignore', env: { ...process.env, ALAMBIC_ROOT: root } })
  child.unref()
}

try { main() } catch {}
process.exit(0)
