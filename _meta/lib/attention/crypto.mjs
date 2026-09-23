import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const KEY_BYTES = 32

export function randomKey() {
  return crypto.randomBytes(KEY_BYTES).toString('base64url')
}

export function decodeKey(value) {
  if (typeof value !== 'string' || !value) throw new Error('attention key is missing')
  const key = Buffer.from(value, 'base64url')
  if (key.length !== KEY_BYTES) throw new Error('attention key must decode to 32 bytes')
  return key
}

export function keyHandle(source, kind) {
  if (!/^[a-z0-9-]+$/.test(source) || !['data', 'hmac'].includes(kind)) throw new Error('invalid attention key handle')
  return `alambic.attention.v1.${source}.${kind}`
}

export function environmentKeyName(handle) {
  const match = /^alambic\.attention\.v1\.([a-z0-9-]+)\.(data|hmac)$/.exec(handle)
  if (!match) return null
  return `ALAMBIC_ATTENTION_${match[1].replaceAll('-', '_').toUpperCase()}_${match[2].toUpperCase()}_KEY`
}

/** True when Keychain fallback is explicitly enabled (default: env-only). */
export function attentionKeychainAllowed(env = process.env) {
  const value = String(env.ALAMBIC_ATTENTION_ALLOW_KEYCHAIN || '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export class MemoryKeyStore {
  #keys = new Map()

  set(handle, value = randomKey()) {
    decodeKey(value)
    this.#keys.set(handle, value)
    return value
  }

  get(handle) {
    return this.#keys.get(handle) || null
  }

  delete(handle) {
    this.#keys.delete(handle)
  }
}

// Primary: per-source keys from local environment (e.g. ~/.zshrc exports).
// Optional fallback: macOS Keychain only when ALAMBIC_ATTENTION_ALLOW_KEYCHAIN=1.
// Values are never emitted by this CLI.
export class MacOSKeychainKeyStore {
  constructor({
    account = process.env.ALAMBIC_ATTENTION_KEYCHAIN_ACCOUNT || 'alambic.attention.v1',
    run = execFileSync,
    allowKeychain = attentionKeychainAllowed(),
  } = {}) {
    this.account = account
    this.run = run
    this.allowKeychain = allowKeychain
  }

  get(handle) {
    try {
      const environmentKey = environmentKeyName(handle)
      const override = environmentKey ? process.env[environmentKey] : null
      if (override) {
        decodeKey(override)
        return override
      }
      if (!this.allowKeychain) return null
      const value = String(this.run('security', ['find-generic-password', '-s', handle, '-a', this.account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim()
      decodeKey(value)
      return value
    } catch {
      return null
    }
  }

  set() {
    throw new Error('attention keys must be provisioned as env vars in ~/.zshrc (see attention env-template); Keychain write is disabled')
  }

  delete(handle) {
    if (!this.allowKeychain) return
    try {
      this.run('security', ['delete-generic-password', '-s', handle, '-a', this.account], { stdio: 'ignore' })
    } catch {
      // A missing key is already a safe disconnected state.
    }
  }
}

export function hmac(value, encodedKey) {
  return crypto.createHmac('sha256', decodeKey(encodedKey)).update(String(value)).digest('hex')
}

export function encryptJson(value, encodedKey) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', decodeKey(encodedKey), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }
}

export function decryptJson(envelope, encodedKey) {
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error('invalid attention ciphertext envelope')
  const decipher = crypto.createDecipheriv('aes-256-gcm', decodeKey(encodedKey), Buffer.from(envelope.iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()])
  return JSON.parse(plaintext.toString('utf8'))
}
