import fs from 'node:fs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function scalar(raw) {
  const value = raw.trim()
  if (!value) return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replaceAll('\\"', '"')
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

export function parseMarkdown(file) {
  const text = fs.readFileSync(file, 'utf8')
  return parseMarkdownText(text)
}

export function parseMarkdownText(text) {
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') throw new Error('missing opening frontmatter')
  const end = lines.indexOf('---', 1)
  if (end < 0) throw new Error('missing closing frontmatter')
  const data = {}
  let current = null
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const item = line.match(/^\s{2}-\s+(.+)$/)
    if (item) {
      if (!current || !Array.isArray(data[current])) throw new Error(`line ${i + 1}: list item without list key`)
      data[current].push(scalar(item[1]))
      continue
    }
    if (/^\s/.test(line)) throw new Error(`line ${i + 1}: nested YAML is not supported`)
    const pair = line.match(/^([a-z][a-z0-9_]*):(?:\s*(.*))?$/)
    if (!pair) throw new Error(`line ${i + 1}: unsupported frontmatter syntax`)
    current = pair[1]
    if (Object.hasOwn(data, current)) throw new Error(`line ${i + 1}: duplicate field '${current}'`)
    data[current] = pair[2] ? scalar(pair[2]) : []
  }
  return { data, body: lines.slice(end + 1).join('\n'), text }
}

export function validateData(data, schema, { strict = false, reference = false } = {}) {
  const errors = []
  const required = strict
    ? (reference ? ['type', 'status', 'summary', 'created', 'updated', 'tags'] : schema.required)
    : ['type', 'status', 'updated']
  for (const key of required) {
    const value = data[key]
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      errors.push({ field: key, message: 'required field is missing or empty', remediation: `add '${key}' to frontmatter` })
    }
  }
  for (const [key, value] of Object.entries(data)) {
    const rule = schema.properties[key]
    if (!rule) {
      if (strict) errors.push({ field: key, message: 'unknown field', remediation: `remove '${key}' or add it to the schema` })
      continue
    }
    if (rule.enum && !rule.enum.includes(value)) {
      errors.push({ field: key, message: `unsupported value '${value}'`, remediation: `use one of: ${rule.enum.join(', ')}` })
    }
    if (rule.type === 'array') {
      if (!Array.isArray(value)) errors.push({ field: key, message: 'must be a YAML list', remediation: `write '${key}:' followed by indented '- value' items` })
      else {
        if (rule.minItems && value.length < rule.minItems) errors.push({ field: key, message: 'list is empty', remediation: 'add at least one item' })
        if (rule.uniqueItems && new Set(value).size !== value.length) errors.push({ field: key, message: 'contains duplicates', remediation: 'remove duplicate items' })
        if (value.some((entry) => typeof entry !== 'string' || !entry.trim())) errors.push({ field: key, message: 'contains a non-string or empty item', remediation: 'use non-empty strings only' })
      }
    }
    if (rule.type === 'string' && typeof value !== 'string') errors.push({ field: key, message: 'must be a string', remediation: `write '${key}: value'` })
    if (rule.format === 'date' && (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) {
      errors.push({ field: key, message: `invalid date '${value}'`, remediation: 'use YYYY-MM-DD' })
    }
  }
  return errors
}

export function readSchema(root) {
  return JSON.parse(fs.readFileSync(`${root}/_meta/note.schema.json`, 'utf8'))
}
