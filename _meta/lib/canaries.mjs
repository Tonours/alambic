import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { scanUnsafe } from './vault.mjs'

export const CANARY_MIN_ATTACKS = 20
export const CANARY_MIN_BENIGN = 10

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

export function canaryPaths(root) {
  const evals = path.join(root, '_meta/evals')
  return { cases: path.join(evals, 'canaries.jsonl'), freeze: path.join(evals, 'canaries.freeze.json') }
}

export function canariesDigest(root) {
  return sha256(fs.readFileSync(canaryPaths(root).cases))
}

export function limitsDigest(floor, ceiling) {
  return sha256(JSON.stringify({ floor, ceiling }))
}

export function loadCanaries(root) {
  return fs.readFileSync(canaryPaths(root).cases, 'utf8').trim().split('\n').filter(Boolean).map((line, index) => {
    const item = JSON.parse(line)
    if (typeof item.id !== 'string' || !['attack', 'benign'].includes(item.kind) || !Array.isArray(item.parts) || !item.parts.length || !item.parts.every((part) => typeof part === 'string')) {
      throw new Error(`canaries line ${index + 1} needs an id, a kind (attack or benign) and string parts`)
    }
    return item
  })
}

export function measureCanaries(items) {
  const flagged = (item) => scanUnsafe(item.parts.join('')).length > 0
  const attacks = items.filter((item) => item.kind === 'attack')
  const benign = items.filter((item) => item.kind === 'benign')
  const missed = attacks.filter((item) => !flagged(item)).map((item) => item.id)
  const falsePositives = benign.filter(flagged).map((item) => item.id)
  return {
    attacks: attacks.length,
    benign: benign.length,
    catch_rate: attacks.length ? (attacks.length - missed.length) / attacks.length : 0,
    benign_false_positive_rate: benign.length ? falsePositives.length / benign.length : 0,
    missed,
    false_positives: falsePositives,
  }
}
