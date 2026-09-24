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

function reserve(file, expected, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const reserved = path.join(dir, `${expected}-${crypto.randomUUID()}-${path.basename(file)}`)
  try { fs.renameSync(file, reserved) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (fileSha(reserved) === expected) return reserved
  restore(reserved, file)
  return null
}

function restore(reserved, file) {
  try { fs.linkSync(reserved, file); fs.unlinkSync(reserved) } catch (error) { if (error.code !== 'EEXIST') throw error }
}

function swapChecked(file, temporary, expected, dir) {
  if (!reserve(file, expected, dir)) return false
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

export function displacedEdits(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names.map((name) => path.join(dir, name)).filter((file) => fileSha(file) !== path.basename(file).slice(0, 64))
}

export function moveChecked(file, dests, expected, env = process.env) {
  if (!expected) return null
  const reserved = reserve(file, expected, path.dirname(dests[0]))
  if (!reserved) return null
  for (const dest of dests) {
    try { fs.linkSync(reserved, dest) } catch (error) { if (error.code === 'EEXIST') continue; throw error }
    fs.unlinkSync(reserved)
    journalRecord(file, expected, null, env)
    return dest
  }
  restore(reserved, file)
  throw new Error(`no free archive name for ${path.basename(file)}`)
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
