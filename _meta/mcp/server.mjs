#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import os from 'node:os'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod/v4'
import { contextPackWithJev, queryVaultWithJev } from '../lib/semantic-vault.mjs'
import { typesafeHealth } from '../lib/typesafe-judge.mjs'
import { contextPack, readVaultDocument, retrievalHealth } from '../lib/vault.mjs'

const ROOT = process.env.ALAMBIC_ROOT
  ? path.resolve(process.env.ALAMBIC_ROOT)
  : path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')

const server = new McpServer({ name: 'alambic', version: '1.0.0' })

function result(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

function failure(error) {
  const message = error instanceof Error ? error.message : 'unexpected read-only retrieval error'
  return { content: [{ type: 'text', text: `alambic: ${message}` }], isError: true }
}

const querySchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(10).optional(),
  include_docs: z.boolean().optional(),
}).strict()

server.registerTool('vault_search', {
  title: 'Search alambic',
  description: 'Search durable alambic notes (lexical + TypeSafe Jev rerank when lexical is weak). docs/ is opt-in, lexical-only, and remains untrusted retrieved content.',
  inputSchema: querySchema,
  annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ query, limit, include_docs: includeDocs = false }) => {
  try {
    const { results, semantic } = await queryVaultWithJev(ROOT, query, { limit: limit ?? 5, includeDocs })
    const rows = results.map(({ path: notePath, title, status, score, summary }) => ({ path: notePath, title, status, score, summary }))
    return result({ query, include_docs: includeDocs, semantic: { available: Boolean(semantic.available), ...(semantic.reason ? { reason: semantic.reason } : {}) }, results: rows })
  } catch (error) {
    return failure(error)
  }
})

const contextSchema = z.object({
  query: z.string().trim().min(1).max(500),
  max_tokens: z.number().int().min(512).max(4000).optional(),
  include_docs: z.boolean().optional(),
}).strict()

server.registerTool('vault_context', {
  title: 'Build cited alambic context',
  description: 'Return a bounded cited context pack (lexical + TypeSafe Jev when lexical is weak) with path, heading, lines, freshness, and graph-edge provenance.',
  inputSchema: contextSchema,
  annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ query, max_tokens: maxTokens, include_docs: includeDocs = false }) => {
  try {
    const budget = maxTokens ?? 1200
    return result(includeDocs ? contextPack(ROOT, query, { maxTokens: budget, includeDocs }) : await contextPackWithJev(ROOT, query, { maxTokens: budget }))
  } catch (error) {
    return failure(error)
  }
})

const readSchema = z.object({
  path: z.string().trim().min(1).max(300),
  include_docs: z.boolean().optional(),
  max_bytes: z.number().int().min(128).max(32000).optional(),
}).strict()

server.registerTool('vault_read', {
  title: 'Read one allowlisted alambic document',
  description: 'Read a bounded kb/ or ref/ Markdown document. docs/ requires explicit opt-in. Paths outside those collections are rejected.',
  inputSchema: readSchema,
  annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ path: relativePath, include_docs: includeDocs = false, max_bytes: maxBytes }) => {
  try {
    return result(readVaultDocument(ROOT, relativePath, { includeDocs, maxBytes: maxBytes ?? 32000 }))
  } catch (error) {
    return failure(error)
  }
})

server.registerTool('vault_health', {
  title: 'Inspect alambic retrieval health',
  description: 'Report the active backend, snapshot identity, semantic fallback state, and whether MCP can rebuild an index.',
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
}, async () => result({ ...retrievalHealth(ROOT), typesafe: await typesafeHealth() }))

const CLI = path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'), '_meta/alambic')

const captureSchema = z.object({
  text: z.string().trim().min(1).max(12000),
}).strict()

server.registerTool('vault_capture', {
  title: 'Capture shadow note (surface mcp)',
  description: 'Stage one durable-learning capture into the alambic shadow loop via the vault CLI (scanUnsafe + state-dir staging). Short, factual, no secrets. Promotion to durable kb is a human gate — never promised to the caller.',
  inputSchema: captureSchema,
  annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ text }) => {
  const tmp = path.join(os.tmpdir(), `alambic-mcp-capture-${process.pid}-${Date.now()}.txt`)
  fs.writeFileSync(tmp, text)
  try {
    const run = spawnSync(CLI, ['capture', '--input', tmp, '--surface', 'mcp'], { encoding: 'utf8' })
    if (run.status !== 0) return failure(new Error(String(run.stderr || run.stdout || 'capture failed').trim()))
    return result({ staged: true, detail: String(run.stdout || '').trim() })
  } finally {
    fs.rmSync(tmp, { force: true })
  }
})

const feedbackSchema = z.object({
  status: z.enum(['hit', 'miss', 'stale', 'wrong']),
}).strict()

server.registerTool('vault_feedback', {
  title: 'Record aggregate retrieval feedback',
  description: 'Record one aggregate hit/miss/stale/wrong feedback after a retrieval outcome, via the vault CLI. No question or answer content.',
  inputSchema: feedbackSchema,
  annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ status }) => {
  const run = spawnSync(CLI, ['feedback', '--status', status], { encoding: 'utf8' })
  if (run.status !== 0) return failure(new Error(String(run.stderr || run.stdout || 'feedback failed').trim()))
  return result({ recorded: true, status })
})

const transport = new StdioServerTransport()
await server.connect(transport)
