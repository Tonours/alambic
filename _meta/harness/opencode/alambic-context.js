// Managed by alambic setup; remove with: alambic setup --uninstall --yes
// Adds lexical vault context to the first model call of a matching prompt.
// State is keyed by session and message; no sessionID means no-op.
import { spawn } from 'node:child_process'

const NODE = "{{NODE}}"
const HOOK = "{{HOOK}}"

export function runHook(prompt, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (value) => { if (!done) { done = true; resolve(value) } }
    try {
      const child = spawn(NODE, [HOOK, '--format', 'text'], { stdio: ['pipe', 'pipe', 'ignore'] })
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish('') }, timeoutMs)
      child.stdout.on('data', (chunk) => { out += chunk })
      child.on('error', () => { clearTimeout(timer); finish('') })
      child.on('close', () => { clearTimeout(timer); finish(out.trim()) })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify({ prompt }))
    } catch {
      finish('')
    }
  })
}

const promptText = (parts) => (Array.isArray(parts) ? parts : [])
  .filter((part) => part?.type === 'text' && typeof part.text === 'string' && !part.synthetic)
  .map((part) => part.text)
  .join('\n')

export const AlambicContext = async () => {
  const pending = new Map() // sessionID -> { messageID, text }
  return {
    'chat.message': async (input, output) => {
      try {
        const sessionID = input?.sessionID
        if (!sessionID) return
        pending.delete(sessionID)
        const text = await runHook(promptText(output?.parts))
        if (text) pending.set(sessionID, { messageID: input?.messageID ?? output?.message?.id, text })
      } catch {
        if (input?.sessionID) pending.delete(input.sessionID)
      }
    },
    'experimental.chat.system.transform': async (input, output) => {
      try {
        const sessionID = input?.sessionID
        if (!sessionID) return
        const entry = pending.get(sessionID)
        pending.delete(sessionID)
        if (entry && Array.isArray(output?.system)) output.system.push(entry.text)
      } catch {}
    },
  }
}
