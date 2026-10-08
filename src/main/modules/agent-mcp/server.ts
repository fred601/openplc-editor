import { randomUUID } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { join } from 'path'

import { authorizationHeaderMatches, generateBearerToken } from './auth'
import { AgentContext } from './context'
import { callTool, prompts, readResource, tools } from './dispatch'
import { AGENT_MCP_PROTOCOL_VERSION, fail, isFailure } from './types'

type JsonRpcId = string | number | null

type RunningServer = {
  port: number
  host: string
  token: string
  close: () => Promise<void>
}

const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  })
  response.end(payload)
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (chunks.reduce((sum, item) => sum + item.length, 0) > 8_000_000) {
        reject(new Error('body too large'))
      }
    })
    request.on('end', () => resolve(Buffer.concat(chunks as unknown as readonly Uint8Array[]).toString('utf-8')))
    request.on('error', reject)
  })

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})

const hostIsLocal = (host: string | undefined): boolean => {
  if (!host) return true
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === '127.0.0.1' || name === 'localhost'
}

const toolResult = (payload: unknown) => {
  const text = JSON.stringify(payload)
  const isError = isFailure(payload)
  return {
    content: [{ type: 'text', text }],
    structuredContent: payload,
    isError,
  }
}

const handleRpc = async (ctx: AgentContext, message: unknown, sessionId: string): Promise<unknown> => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request')
  }
  const request = message as { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: unknown }
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') return rpcError(request.id ?? null, -32600, 'Invalid Request')
  const id = request.id ?? null
  const params = (request.params ?? {}) as Record<string, unknown>

  if (request.method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: AGENT_MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: { name: 'openplc-editor', version: ctx.deps.version },
      instructions:
        'Bind is 127.0.0.1. Read userData/User/agent-mcp.json for the port and bearer token. Long work returns a jobId; poll job_get. Do not write build/.',
    })
  }
  if (request.method === 'notifications/initialized' || request.method.startsWith('notifications/')) {
    return null
  }
  if (request.method === 'ping') return rpcResult(id, {})
  if (request.method === 'tools/list') {
    return rpcResult(id, {
      tools: Object.entries(tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    })
  }
  if (request.method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : ''
    const payload = await callTool(ctx, name, params.arguments ?? {})
    return rpcResult(id, toolResult(payload))
  }
  if (request.method === 'resources/list') {
    return rpcResult(id, {
      resources: [
        { uri: 'openplc://session', name: 'session', mimeType: 'application/json' },
        { uri: 'openplc://project/xml', name: 'project-xml', mimeType: 'application/xml' },
        { uri: 'openplc://hardware/boards', name: 'boards', mimeType: 'application/json' },
      ],
    })
  }
  if (request.method === 'resources/templates/list') {
    return rpcResult(id, {
      resourceTemplates: [
        { uriTemplate: 'openplc://jobs/{id}', name: 'job', mimeType: 'application/json' },
      ],
    })
  }
  if (request.method === 'resources/read') {
    const uri = typeof params.uri === 'string' ? params.uri : ''
    const resource = await readResource(ctx, uri)
    if (isFailure(resource)) return rpcResult(id, toolResult(resource))
    return rpcResult(id, { contents: [resource] })
  }
  if (request.method === 'prompts/list') {
    return rpcResult(id, { prompts: prompts.map(({ name, description }) => ({ name, description })) })
  }
  if (request.method === 'prompts/get') {
    const name = typeof params.name === 'string' ? params.name : ''
    const prompt = prompts.find((item) => item.name === name)
    if (!prompt) return rpcError(id, -32602, `Unknown prompt ${name}`)
    return rpcResult(id, {
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text: prompt.text } }],
    })
  }
  return rpcError(id, -32601, `Method not found: ${request.method} (session ${sessionId})`)
}

const startAgentHttpServer = async (ctx: AgentContext): Promise<RunningServer> => {
  const token = generateBearerToken()
  const sessionIds = new Set<string>()

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        if (!hostIsLocal(request.headers.host)) {
          json(response, 403, fail('unauthorized', 'Host is not local.'))
          return
        }
        const origin = request.headers.origin
        if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
          json(response, 403, fail('unauthorized', 'Origin is not local.'))
          return
        }
        if (!authorizationHeaderMatches(request.headers.authorization, token)) {
          json(response, 401, fail('unauthorized', 'Bearer token is missing or does not match.'))
          return
        }
        const url = new URL(request.url || '/', 'http://127.0.0.1')
        if (url.pathname !== '/' && url.pathname !== '/mcp') {
          json(response, 404, fail('not-found', 'MCP endpoint is /mcp'))
          return
        }
        if (request.method === 'DELETE') {
          const session = request.headers['mcp-session-id']
          if (typeof session === 'string') sessionIds.delete(session)
          response.writeHead(204)
          response.end()
          return
        }
        if (request.method !== 'POST') {
          json(response, 405, fail('validation', 'This server answers JSON-RPC POST. Jobs are polled with job_get.'))
          return
        }
        const raw = await readBody(request)
        let message: unknown
        try {
          message = JSON.parse(raw) as unknown
        } catch {
          json(response, 400, rpcError(null, -32700, 'Parse error'))
          return
        }
        const method = message && typeof message === 'object' && 'method' in message ? String(message.method) : ''
        let sessionId = typeof request.headers['mcp-session-id'] === 'string' ? request.headers['mcp-session-id'] : ''
        if (method !== 'initialize' && sessionId && !sessionIds.has(sessionId)) {
          json(response, 404, fail('not-found', 'Unknown MCP session.'))
          return
        }
        if (method === 'initialize') sessionId = randomUUID()
        const result = await handleRpc(ctx, message, sessionId || 'none')
        if (method === 'initialize') sessionIds.add(sessionId)
        if (result == null) {
          response.writeHead(202)
          response.end()
          return
        }
        const headers: Record<string, string> = {}
        if (method === 'initialize') headers['Mcp-Session-Id'] = sessionId
        json(response, 200, result, headers)
      } catch (error) {
        json(response, 500, rpcError(null, -32603, error instanceof Error ? error.message : 'Internal error'))
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MCP server did not bind a TCP port')
  const directory = join(ctx.deps.userDataPath, 'User')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'agent-mcp.json'),
    JSON.stringify({ port: address.port, token, pid: ctx.deps.pid, version: ctx.deps.version }, null, 2),
    { mode: 0o600 },
  )

  return {
    port: address.port,
    host: address.address,
    token,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

export { startAgentHttpServer }
export type { RunningServer }
