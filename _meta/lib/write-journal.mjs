import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const digest = (content) => crypto.createHash('sha256').update(content).digest('hex')

export function fileSha(file) {
  try { return digest(fs.readFileSync(file)) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export function journalRecord(file, before, after, env = process.env) {
  if (!env.ALAMBIC_WRITE_JOURNAL) return
  fs.appendFileSync(env.ALAMBIC_WRITE_JOURNAL, `${JSON.stringify({ path: path.resolve(file), before, after })}\n`)
}

function swapChecked(file, temporary, expected, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const displaced = path.join(dir, `${expected}-${crypto.randomUUID()}-${path.basename(file)}`)
  try { fs.renameSync(file, displaced) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  if (fileSha(displaced) !== expected) {
    try { fs.linkSync(displaced, file); fs.unlinkSync(displaced) } catch (error) { if (error.code !== 'EEXIST') throw error }
    return false
  }
  fs.linkSync(temporary, file)
  return true
}

export function writeChecked(file, before, after, env = process.env) {
  const expected = before === null ? null : digest(before)
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, after, 'utf8')
  try {
    if (expected === null) fs.linkSync(temporary, file)
    else if (env.ALAMBIC_DISPLACED_DIR) { if (!swapChecked(file, temporary, expected, env.ALAMBIC_DISPLACED_DIR)) return false }
    else if (fileSha(file) === expected) fs.renameSync(temporary, file)
    else return false
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  journalRecord(file, expected, digest(after), env)
  return true
}

export function displacedEdits(dir, { prune = false } = {}) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const kept = []
  for (const name of names) {
    const file = path.join(dir, name)
    if (fileSha(file) !== name.slice(0, 64)) kept.push(file)
    else if (prune) fs.rmSync(file, { force: true })
  }
  return kept
}

export function moveChecked(file, dest, env = process.env) {
  const before = fileSha(file)
  if (before === null) return false
  try {
    fs.linkSync(file, dest)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL)
  }
  fs.unlinkSync(file)
  journalRecord(file, before, null, env)
  return true
}

export function readJournal(journal) {
  const chains = new Map()
  let text = ''
  try { text = fs.readFileSync(journal, 'utf8') } catch { return chains }
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      if (typeof entry.path !== 'string') continue
      if (!chains.has(entry.path)) chains.set(entry.path, [])
      chains.get(entry.path).push({ before: entry.before ?? null, after: entry.after ?? null })
    } catch {}
  }
  return chains
}

export function vaultDir(root, relative) {
  const dir = path.join(root, relative)
  fs.mkdirSync(dir, { recursive: true })
  if (fs.realpathSync.native(dir) !== path.join(fs.realpathSync.native(root), ...relative.split('/'))) throw new Error(`${relative} must be a real directory inside the vault`)
  return dir
}
