import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const digest = (content) => crypto.createHash('sha256').update(content).digest('hex')

export function fileSha(file) {
  try { return digest(fs.readFileSync(file)) } catch { return null }
}

export function journalWrite(file, content, env = process.env) {
  if (!env.ALAMBIC_WRITE_JOURNAL) return
  const sha = content === null ? null : digest(content)
  fs.appendFileSync(env.ALAMBIC_WRITE_JOURNAL, `${JSON.stringify({ path: path.resolve(file), sha })}\n`)
}

export function readJournal(journal) {
  const entries = new Map()
  let text = ''
  try { text = fs.readFileSync(journal, 'utf8') } catch { return entries }
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      if (typeof entry.path === 'string') entries.set(entry.path, entry.sha ?? null)
    } catch {}
  }
  return entries
}
