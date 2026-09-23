import { spawn } from 'node:child_process'

const NODE = "{{NODE}}"
const HOOK = "{{HOOK}}"
const TYPE = 'alambic-context'

export function runHook(prompt: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (value: string) => { if (!done) { done = true; resolve(value) } }
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

export function keepLatest(messages: any[]): any[] {
  let last = -1
  messages.forEach((message, index) => { if (message?.role === 'custom' && message.customType === TYPE) last = index })
  return messages.filter((message, index) => !(message?.role === 'custom' && message.customType === TYPE) || index === last)
}

export default function (pi: any) {
  pi.on('before_agent_start', async (event: any) => {
    try {
      const content = await runHook(String(event?.prompt ?? ''))
      return content ? { message: { customType: TYPE, content, display: false } } : undefined
    } catch {
      return undefined
    }
  })
  pi.on('context', async (event: any) => {
    try {
      return Array.isArray(event?.messages) ? { messages: keepLatest(event.messages) } : undefined
    } catch {
      return undefined
    }
  })
}
