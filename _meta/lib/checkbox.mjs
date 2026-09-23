export function initialState(rows) {
  return { rows: rows.map((row) => ({ ...row })), cursor: 0, done: false, aborted: false }
}

export function decodeKeys(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  const keys = []
  for (let i = 0; i < text.length; i += 1) {
    const rest = text.slice(i)
    if (rest.startsWith('\x1b[A') || rest.startsWith('\x1bOA')) { keys.push('up'); i += 2 }
    else if (rest.startsWith('\x1b[B') || rest.startsWith('\x1bOB')) { keys.push('down'); i += 2 }
    else if (text[i] === 'k') keys.push('up')
    else if (text[i] === 'j') keys.push('down')
    else if (text[i] === ' ') keys.push('space')
    else if (text[i] === 'a') keys.push('all')
    else if (text[i] === '\r' || text[i] === '\n') keys.push('enter')
    else if (text[i] === 'q' || text[i] === '\x03' || text[i] === '\x04') keys.push('quit')
  }
  return keys
}

export function reduce(state, key) {
  if (state.done || state.aborted || !state.rows.length) return state
  const count = state.rows.length
  switch (key) {
    case 'up': return { ...state, cursor: (state.cursor - 1 + count) % count }
    case 'down': return { ...state, cursor: (state.cursor + 1) % count }
    case 'space': return { ...state, rows: state.rows.map((row, index) => (index === state.cursor ? { ...row, checked: !row.checked } : row)) }
    case 'all': {
      const next = !state.rows.every((row) => row.checked)
      return { ...state, rows: state.rows.map((row) => ({ ...row, checked: next })) }
    }
    case 'enter': return { ...state, done: true }
    case 'quit': return { ...state, aborted: true }
    default: return state
  }
}

export function render(state, title = '') {
  const lines = []
  if (title) lines.push(title)
  lines.push('Space toggle, arrows move, a all, Enter confirm, q quit')
  let group = null
  state.rows.forEach((row, index) => {
    if (row.group && row.group !== group) {
      group = row.group
      lines.push(group)
    }
    const pointer = index === state.cursor ? '>' : ' '
    lines.push(` ${pointer} [${row.checked ? 'x' : ' '}] ${row.label.padEnd(20)} ${row.hint || ''}`.trimEnd())
  })
  return `${lines.join('\n')}\n`
}

export function runPicker(rows, { input = process.stdin, output = process.stdout, title = '', draw = render } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.reject(new Error('picker needs a TTY'))
  const wasRaw = Boolean(input.isRaw)
  let state = initialState(rows)
  let drawn = 0
  return new Promise((resolve, reject) => {
    let settled = false
    const paint = () => {
      const text = draw(state, title)
      if (drawn) output.write(`\x1b[${drawn}A\x1b[J`)
      output.write(text)
      drawn = text.split('\n').length - 1
    }
    const cleanup = () => {
      input.off('data', onData)
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      try { input.setRawMode(wasRaw) } catch {}
      input.pause()
      output.write('\x1b[?25h')
    }
    const finish = (settle) => {
      if (settled) return
      settled = true
      cleanup()
      settle()
    }
    function onSignal() { finish(() => resolve(null)) }
    function onData(chunk) {
      try {
        for (const key of decodeKeys(chunk)) state = reduce(state, key)
        if (state.aborted) return finish(() => resolve(null))
        if (state.done) return finish(() => resolve(state.rows))
        paint()
      } catch (error) {
        finish(() => reject(error))
      }
    }
    try {
      input.setRawMode(true)
      input.on('data', onData)
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
      input.resume()
      output.write('\x1b[?25l')
      paint()
    } catch (error) {
      finish(() => reject(error))
    }
  })
}
