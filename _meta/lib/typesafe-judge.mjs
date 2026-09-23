import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanUnsafe } from './vault.mjs'

export const TYPESAFE_MODEL = 'jev-1.13.0'
export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai'
export const TYPESAFE_MAX_STATE_BYTES = 24_000
export const TYPESAFE_MAX_REQUEST_BYTES = 36_000
export const TYPESAFE_MAX_QUESTIONS = 40
export const TYPESAFE_TIMEOUT_MS = 5_000

const JUDGEMENT_MEMO_LIMIT = 64
const SDK_CLIENT = {}
const judgementMemos = new WeakMap()

let sdkModule = null

function judgementMemo(client) {
  const owner = client || SDK_CLIENT
  if (!judgementMemos.has(owner)) judgementMemos.set(owner, new Map())
  return judgementMemos.get(owner)
}

function judgementKey(state, questions, model) {
  return crypto.createHash('sha256').update(JSON.stringify({ state, questions, model })).digest('hex')
}

function rememberJudgement(memo, key, judgement) {
  if (memo.size >= JUDGEMENT_MEMO_LIMIT) memo.delete(memo.keys().next().value)
  memo.set(key, judgement)
}

export const noul = (instructions, criteria) => ({ type: 'noul', instructions, criteria })
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria })

export function loadTypesafeSdk() {
  sdkModule ||= import('@typesafe-ai/sdk').catch(() => null)
  return sdkModule
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function versionedModel(value) {
  const model = String(value || TYPESAFE_MODEL).trim()
  if (model !== TYPESAFE_MODEL) throw new Error(`TypeSafe model is pinned to ${TYPESAFE_MODEL}`)
  return TYPESAFE_MODEL
}

export function typesafeConfig(env = process.env, { enabled = true } = {}) {
  const model = versionedModel(env.ALAMBIC_TYPESAFE_MODEL)
  return {
    enabled: Boolean(enabled),
    credential_available: Boolean(String(env.TYPESAFE_API_KEY || '').trim()),
    model,
    base_url: TYPESAFE_BASE_URL,
    timeout_ms: clampInteger(env.ALAMBIC_TYPESAFE_TIMEOUT_MS, TYPESAFE_TIMEOUT_MS, 1_000, 30_000),
    max_state_bytes: TYPESAFE_MAX_STATE_BYTES,
    max_request_bytes: TYPESAFE_MAX_REQUEST_BYTES,
    max_questions: TYPESAFE_MAX_QUESTIONS,
    default_mode: 'enforced',
    retention_boundary: 'external-provider-non-zdr-by-default',
  }
}

function allStrings(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) for (const item of value) allStrings(item, output)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      output.push(key)
      allStrings(item, output)
    }
  }
  return output
}

export function validateTypesafeRequest(state, questions) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('TypeSafe state must be a named object')
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) throw new Error('TypeSafe questions must be a named object')
  const entries = Object.entries(questions)
  if (!entries.length || entries.length > TYPESAFE_MAX_QUESTIONS) throw new Error(`TypeSafe questions must contain 1-${TYPESAFE_MAX_QUESTIONS} entries`)
  const stateBytes = Buffer.byteLength(JSON.stringify(state))
  if (stateBytes > TYPESAFE_MAX_STATE_BYTES) throw new Error(`TypeSafe state exceeds ${TYPESAFE_MAX_STATE_BYTES} bytes`)
  const requestBytes = Buffer.byteLength(JSON.stringify({ state, questions }))
  if (requestBytes > TYPESAFE_MAX_REQUEST_BYTES) throw new Error(`TypeSafe request exceeds ${TYPESAFE_MAX_REQUEST_BYTES} bytes`)
  const unsafe = [...new Set(allStrings({ state, questions }).flatMap((value) => scanUnsafe(value)))]
  if (unsafe.length) throw new Error(`TypeSafe request rejected by local safety scan: ${unsafe.join(', ')}`)
  return { state_bytes: stateBytes, request_bytes: requestBytes, questions: entries.length }
}

function probability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

function validateDistribution(probabilities, labels) {
  if (!probabilities || typeof probabilities !== 'object' || Array.isArray(probabilities)) return false
  const keys = Object.keys(probabilities).sort()
  if (JSON.stringify(keys) !== JSON.stringify([...labels].sort())) return false
  const values = keys.map((key) => probabilities[key])
  const total = values.reduce((sum, value) => sum + value, 0)
  return values.every(probability) && Math.abs(total - 1) <= 0.02
}

export function validateTypesafeResult(result, questions, expectedModel) {
  if (!result || typeof result !== 'object' || result.model !== expectedModel) throw new Error('TypeSafe response model does not match the pinned model')
  if (!result.usage || !Number.isInteger(result.usage.input_tokens) || result.usage.input_tokens < 0
    || !Number.isInteger(result.usage.output_tokens) || result.usage.output_tokens < 0) {
    throw new Error('TypeSafe response usage is invalid')
  }
  if (!result.answers || typeof result.answers !== 'object') throw new Error('TypeSafe response answers are missing')
  const answers = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = result.answers[id]
    if (!answer || answer.type !== question.type) throw new Error(`TypeSafe response answer '${id}' has an invalid type`)
    if (question.type === 'noul') {
      if (!probability(answer.noul)) throw new Error(`TypeSafe noul '${id}' is invalid`)
      answers[id] = { type: 'noul', noul: answer.noul }
    } else if (question.type === 'choice') {
      const labels = Object.keys(question.criteria)
      const selectedProbability = answer.probabilities?.[answer.choice]
      const maximumProbability = Math.max(...Object.values(answer.probabilities || {}).filter(Number.isFinite))
      if (!labels.includes(answer.choice) || !probability(answer.confidence) || !validateDistribution(answer.probabilities, labels)
        || selectedProbability < maximumProbability) {
        throw new Error(`TypeSafe choice '${id}' is invalid`)
      }
      answers[id] = { type: 'choice', choice: answer.choice, confidence: selectedProbability, probabilities: { ...answer.probabilities } }
    } else if (question.type === 'score') {
      const labels = question.criteria.map((_, index) => String(index))
      if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1
        || !probability(answer.confidence) || !validateDistribution(answer.probabilities, labels)) {
        throw new Error(`TypeSafe score '${id}' is invalid`)
      }
      answers[id] = { type: 'score', score: answer.score, confidence: answer.confidence, probabilities: { ...answer.probabilities } }
    }
  }
  return {
    model: result.model,
    usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
    answers,
  }
}

function safeReason(error, sdk) {
  if (sdk && error instanceof sdk.AuthenticationError) return 'authentication_failed'
  if (sdk && error instanceof sdk.RateLimitError) return 'rate_limited'
  if (sdk && error instanceof sdk.APITimeoutError) return 'timeout'
  if (sdk && error instanceof sdk.APIConnectionError) return 'connection_failed'
  if (sdk && error instanceof sdk.APIError) return 'provider_rejected'
  if (error instanceof Error && /response|model|answer|usage|choice|score|noul/i.test(error.message)) return 'invalid_response'
  return 'provider_unavailable'
}

function auditProviderCall(env) {
  const requested = String(env.ALAMBIC_TYPESAFE_AUDIT_FILE || '').trim()
  if (!requested) return
  const resolved = path.resolve(requested)
  const target = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved))
  const tempRoot = `${fs.realpathSync(os.tmpdir())}${path.sep}`
  if (!target.startsWith(tempRoot)) throw new Error('TypeSafe audit file must be under the system temporary directory')
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.appendFileSync(target, `${JSON.stringify({ event: 'provider_call' })}\n`, { mode: 0o600 })
}

export async function askJev({ state, questions }, {
  env = process.env,
  enabled,
  client = null,
  timeoutMs = null,
} = {}) {
  let config
  try {
    config = typesafeConfig(env, { enabled })
    if (Number.isFinite(timeoutMs)) config.timeout_ms = Math.min(config.timeout_ms, Math.max(100, timeoutMs))
  } catch {
    return { available: false, reason: 'invalid_configuration' }
  }
  if (!config.enabled) return { available: false, reason: 'disabled', model: config.model }
  if (!client && !config.credential_available) return { available: false, reason: 'credential_missing', model: config.model }

  let request
  try {
    request = validateTypesafeRequest(state, questions)
  } catch (error) {
    return { available: false, reason: error instanceof Error && error.message.includes('safety scan') ? 'unsafe_input' : 'invalid_request', model: config.model }
  }
  const memo = judgementMemo(client)
  const key = judgementKey(state, questions, config.model)
  const remembered = memo.get(key)
  if (remembered) return { ...remembered, latency_ms: 0, usage: { input_tokens: 0, output_tokens: 0 } }
  try {
    auditProviderCall(env)
  } catch {
    return { available: false, reason: 'invalid_request', model: config.model }
  }

  const sdk = await loadTypesafeSdk()
  if (!client && !sdk) return { available: false, reason: 'sdk_missing', model: config.model }
  const started = performance.now()
  try {
    const provider = client || new sdk.TypeSafeClient({
      apiKey: env.TYPESAFE_API_KEY,
      baseURL: TYPESAFE_BASE_URL,
      defaultModel: config.model,
      timeout: config.timeout_ms,
      retry: { maxRetries: 0 },
      logLevel: 'off',
    })
    const raw = await provider.systemOne({ state, questions, model: config.model }, { timeout: config.timeout_ms, retry: { maxRetries: 0 } })
    const result = validateTypesafeResult(raw, questions, config.model)
    const judgement = {
      available: true,
      model: result.model,
      answers: result.answers,
      usage: result.usage,
      latency_ms: Math.round((performance.now() - started) * 100) / 100,
      request,
    }
    rememberJudgement(memo, key, judgement)
    return judgement
  } catch (error) {
    return {
      available: false,
      reason: safeReason(error, sdk),
      model: config.model,
      latency_ms: Math.round((performance.now() - started) * 100) / 100,
      request,
    }
  }
}

export async function typesafeHealth(env = process.env) {
  let config
  try {
    config = typesafeConfig(env)
  } catch {
    return { ...typesafeConfig({ ...env, ALAMBIC_TYPESAFE_MODEL: undefined }), state: 'degraded', reason: 'invalid_configuration' }
  }
  if (!config.credential_available) return { ...config, state: 'degraded', reason: 'credential_missing' }
  if (!(await loadTypesafeSdk())) return { ...config, state: 'degraded', reason: 'sdk_missing' }
  return { ...config, state: 'active' }
}
