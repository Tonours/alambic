import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Read side stays exact. Historical writers stored the lowercase prefix
// "oracle:" with no padding, and a human reason such as " Oracle: …" must
// keep counting toward reviews_ge_20. Write side is stricter: trim and ignore
// case, so a new review cannot store that prefix.
export function isStoredOracleReason(reason) {
  return typeof reason === 'string' && reason.startsWith('oracle:')
}

export function isRefusedReviewReason(reason) {
  return typeof reason === 'string' && reason.trim().toLowerCase().startsWith('oracle:')
}

// Human `alambic review --decision` receipts are the only files that count
// toward reviews_ge_20 / supervision_ready. Oracle-labeled leftovers from
// older sidekick runs stay visible and do not move that gate.
export function isHumanDecisionReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return false
  if (receipt.version !== 1) return false
  if (!['accept', 'reject'].includes(receipt.decision)) return false
  if (typeof receipt.reason !== 'string' || !receipt.reason.trim()) return false
  if (isStoredOracleReason(receipt.reason)) return false
  if (typeof receipt.proposal_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.proposal_sha256)) return false
  if (typeof receipt.reviewed_at !== 'string' || !Number.isFinite(Date.parse(receipt.reviewed_at))) return false
  const payload = canonicalReceiptPayload(receipt)
  return Boolean(payload) && crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') === receipt.receipt_sha256
}

const RECEIPT_FIELDS = ['version', 'proposal_sha256', 'decision', 'reason', 'reviewed_at']

export function canonicalReceiptPayload(receipt) {
  const keys = Object.keys(receipt)
  if (keys.length !== RECEIPT_FIELDS.length + 1 || !keys.includes('receipt_sha256') || RECEIPT_FIELDS.some((field) => !keys.includes(field))) return null
  return Object.fromEntries(RECEIPT_FIELDS.map((field) => [field, receipt[field]]))
}

export function readReviewLedger(stateRoot) {
  const dir = path.join(stateRoot, 'reviews')
  const human = []
  const oracle = []
  const other = []
  if (!fs.existsSync(dir)) return { human, oracle, other, human_count: 0, oracle_count: 0 }
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    let receipt
    try {
      receipt = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      other.push(name)
      continue
    }
    if (isHumanDecisionReceipt(receipt)) human.push(name)
    else if (isStoredOracleReason(receipt?.reason)) oracle.push(name)
    else other.push(name)
  }
  return { human, oracle, other, human_count: human.length, oracle_count: oracle.length }
}
