import { createProjectDefaultStructure } from '@root/main/services/project-service/utils/create-project'
import { PLCPou, PLCVariable } from '@root/types/PLC/open-plc'
import { mkdir,mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { AgentContext } from './context'
import { applyProjectXml, exportProjectXml, projectionToPou } from './iec-map'
import { createLinkedPorts } from './ports'
import { startAgentHttpServer } from './server'
import { AgentDeps, ProjectBundle } from './types'
import { parseVariablesCsv } from './variables-csv'

jest.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getName: () => 'open-plc-editor',
    isPackaged: false,
    getVersion: () => '4.0.6-beta',
  },
  dialog: {},
  BrowserWindow: class {},
  ipcMain: { handle() {}, on() {}, removeListener() {} },
  MessageChannelMain: class {},
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: () => undefined },
}))

const variable = (overrides: Partial<PLCVariable> & Pick<PLCVariable, 'name'>): PLCVariable => ({
  class: 'local',
  type: { definition: 'base-type', value: 'bool' },
  location: '',
  documentation: '',
  debug: false,
  ...overrides,
})

const approvals: boolean[] = []
let approvalCalls = 0

const deps = (root: string, extra: Partial<AgentDeps> = {}): AgentDeps => ({
  version: '4.0.6-beta',
  userDataPath: root,
  pid: 4242,
  projectService: {
    createProject(data) {
      const created = createProjectDefaultStructure(data.path, data)
      if (!created.success || !created.data) return Promise.resolve({ success: false, error: created.error })
      return Promise.resolve({ success: true, data: created.data })
    },
    async openProjectByPath(projectPath) {
      const { readFileSync, readdirSync, existsSync } = await import('fs')
      const project = JSON.parse(readFileSync(join(projectPath, 'project.json'), 'utf-8')) as ProjectBundle['project']
      const pous: PLCPou[] = []
      for (const folder of ['programs', 'functions', 'function-blocks']) {
        const dir = join(projectPath, 'pous', folder)
        if (!existsSync(dir)) continue
        for (const file of readdirSync(dir)) {
          if (!file.endsWith('.json')) continue
          pous.push(JSON.parse(readFileSync(join(dir, file), 'utf-8')) as PLCPou)
        }
      }
      const deviceConfiguration = JSON.parse(
        readFileSync(join(projectPath, 'devices/configuration.json'), 'utf-8'),
      ) as ProjectBundle['deviceConfiguration']
      const devicePinMapping = JSON.parse(
        readFileSync(join(projectPath, 'devices/pin-mapping.json'), 'utf-8'),
      ) as ProjectBundle['devicePinMapping']
      return {
        success: true,
        data: { meta: { path: projectPath }, content: { project, pous, deviceConfiguration, devicePinMapping } },
      }
    },
    async saveProject(data) {
      const { mkdir: mkdirSync, writeFile: write } = await import('fs/promises')
      await mkdirSync(join(data.projectPath, 'devices'), { recursive: true })
      await write(join(data.projectPath, 'project.json'), JSON.stringify(data.content.projectData, null, 2))
      await write(
        join(data.projectPath, 'devices/configuration.json'),
        JSON.stringify(data.content.deviceConfiguration, null, 2),
      )
      await write(join(data.projectPath, 'devices/pin-mapping.json'), JSON.stringify(data.content.devicePinMapping, null, 2))
      for (const pou of data.content.pous) {
        const folder = pou.type === 'function' ? 'functions' : pou.type === 'function-block' ? 'function-blocks' : 'programs'
        await mkdirSync(join(data.projectPath, 'pous', folder), { recursive: true })
        await write(join(data.projectPath, 'pous', folder, `${pou.data.name}.json`), JSON.stringify(pou, null, 2))
      }
      return { success: true }
    },
    listRecent() {
      return Promise.resolve([
        { name: 'Pump', path: '/tmp/pump', lastOpenedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
      ])
    },
  },
  compileProgram: (_args, port) => {
    port.start()
    port.postMessage({ logLevel: 'info', message: 'Starting compilation process...' })
    port.postMessage({ logLevel: 'info', message: 'xml2st generated program.st' })
    port.postMessage({ logLevel: 'info', message: 'iec2c generated C files' })
    port.close()
    return Promise.resolve()
  },
  compileForDebugger: (_args, port) => {
    port.start()
    port.postMessage({ logLevel: 'info', message: 'Starting debug compilation process...' })
    port.close()
    return Promise.resolve()
  },
  hardware: {
    getAvailableBoards() {
      return Promise.resolve(
        new Map([['OpenPLC Runtime v4', { core: 'openplc', specs: { CPU: 'generic' }, pins: { defaultDin: ['0'] } }]]),
      )
    },
    getAvailableSerialPorts() {
      return Promise.resolve(['/dev/ttyMOCK0'])
    },
  },
  readHals() {
    return Promise.resolve({
      'OpenPLC Runtime v4': { compiler: 'openplc-compiler' },
      'Arduino Mega': { compiler: 'arduino-cli', core: 'arduino:avr' },
    })
  },
  runtime: {
    login() {
      return Promise.resolve({ success: true, accessToken: 'jwt-test-token' })
    },
    status() {
      return Promise.resolve({ success: true, status: 'STOPPED' })
    },
    start() {
      return Promise.resolve({ success: true })
    },
    stop() {
      return Promise.resolve({ success: true })
    },
    users() {
      return Promise.resolve({ hasUsers: true })
    },
    request() {
      return Promise.resolve({ success: true })
    },
  },
  debugger: {
    connect() {
      return Promise.resolve({ success: true })
    },
    disconnect() {
      return Promise.resolve({ success: true })
    },
    verifyMd5(expectedMd5) {
      return Promise.resolve({ success: true, match: expectedMd5 === 'abc', targetMd5: 'abc' })
    },
    readVariables(indexes) {
      return Promise.resolve({
        success: true,
        tick: 7,
        lastIndex: indexes[indexes.length - 1] ?? 0,
        data: indexes.map((index) => index + 1),
      })
    },
  },
  renderer: {
    syncProject: () => undefined,
    consoleLog: () => undefined,
    requestApproval: () => {
      approvalCalls += 1
      return Promise.resolve(approvals.length > 0 ? Boolean(approvals.shift()) : true)
    },
    querySnapshot: () => Promise.resolve(null),
    setLockState: () => undefined,
    setRuntimeConnection: () => undefined,
  },
  createChannel: createLinkedPorts,
  ...extra,
})

const rpc = async (port: number, token: string | undefined, body: unknown, sessionId?: string) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  return {
    status: response.status,
    session: response.headers.get('mcp-session-id'),
    body: text ? (JSON.parse(text) as { result?: { structuredContent?: Record<string, unknown> }; error?: { message?: string } }) : null,
  }
}

const connect = async (port: number, token: string) => {
  const init = await rpc(port, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  })
  const session = init.session || ''
  await rpc(port, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, session)
  return session
}

const waitJob = async (port: number, token: string, session: string, jobId: unknown) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const job = await tool(port, token, session, 'job_get', { jobId })
    if (job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error('job stayed running')
}

const tool = async (port: number, token: string, session: string, name: string, args: unknown = {}) => {
  const response = await rpc(
    port,
    token,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    session,
  )
  return response.body?.result?.structuredContent as Record<string, unknown>
}

describe('agent MCP', () => {
  let root = ''
  let server: Awaited<ReturnType<typeof startAgentHttpServer>> | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openplc-agent-'))
    approvals.length = 0
    approvalCalls = 0
  })

  afterEach(async () => {
    await server?.close()
    server = undefined
    await rm(root, { recursive: true, force: true })
  })

  const boot = async (extra?: Partial<AgentDeps>) => {
    server = await startAgentHttpServer(new AgentContext(deps(root, extra)))
    const session = await connect(server.port, server.token)
    return { session, port: server.port, token: server.token }
  }

  it('rejects a request without a bearer token and binds only localhost', async () => {
    server = await startAgentHttpServer(new AgentContext(deps(root)))
    expect(server.host).toBe('127.0.0.1')
    const denied = await rpc(server.port, undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(denied.status).toBe(401)
    const discovery = JSON.parse(await readFile(join(root, 'User', 'agent-mcp.json'), 'utf-8')) as {
      port: number
      token: string
      pid: number
      version: string
    }
    expect(discovery.port).toBe(server.port)
    expect(discovery.token).toBe(server.token)
    expect(discovery.pid).toBe(4242)
    expect(discovery.version).toBe('4.0.6-beta')
    const mode = (await stat(join(root, 'User', 'agent-mcp.json'))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('creates the project layout and returns compiler logs without leaving the process', async () => {
    const client = await boot()
    const projectPath = join(root, 'pump')
    const created = await tool(client.port, client.token, client.session, 'project_create', {
      name: 'Pump',
      path: projectPath,
      language: 'st',
      type: 'plc-project',
      time: 'T#20ms',
    })
    expect(created.ok).toBe(true)
    const mainPou = JSON.parse(await readFile(join(projectPath, 'pous/programs/main.json'), 'utf-8')) as PLCPou
    expect(mainPou.data.name).toBe('main')
    const projectFile = JSON.parse(await readFile(join(projectPath, 'project.json'), 'utf-8')) as { data: { pous: unknown[] } }
    expect(projectFile.data.pous).toEqual([])
    await expect(stat(join(projectPath, 'devices/configuration.json'))).resolves.toBeTruthy()
    await expect(stat(join(projectPath, 'devices/pin-mapping.json'))).resolves.toBeTruthy()

    const started = await tool(client.port, client.token, client.session, 'compile_start', {
      boardTarget: 'OpenPLC Runtime v4',
      compileOnly: true,
    })
    expect(typeof started.jobId).toBe('string')
    const job = await waitJob(client.port, client.token, client.session, started.jobId)
    const messages = (job.logs as Array<{ message: string }>).map((entry) => entry.message).join('\n')
    expect(messages).toContain('Starting compilation process...')
    expect(messages).toContain('xml2st')
    expect(messages).toContain('iec2c')
    expect(job.status).toBe('success')

    const info = await tool(client.port, client.token, client.session, 'session_info')
    expect(info.version).toBe('4.0.6-beta')
    expect(info.openProjectPath).toBe(projectPath)
  })

  it('marks the job error when the compiler reports an error and still answers', async () => {
    const client = await boot({
      compileProgram: (_args, port) => {
        port.start()
        port.postMessage({ logLevel: 'info', message: 'Starting compilation process...' })
        port.postMessage({ logLevel: 'error', message: 'xml2st failed' })
        port.close()
        return Promise.resolve()
      },
    })
    const projectPath = join(root, 'pump')
    await tool(client.port, client.token, client.session, 'project_create', {
      name: 'Pump',
      path: projectPath,
      language: 'st',
      type: 'plc-project',
      time: 'T#20ms',
    })
    const started = await tool(client.port, client.token, client.session, 'compile_start', {
      boardTarget: 'OpenPLC Runtime v4',
    })
    const job = await waitJob(client.port, client.token, client.session, started.jobId)
    expect(job.status).toBe('error')
    const info = await tool(client.port, client.token, client.session, 'session_info')
    expect(info.ok).toBe(true)
  })

  it('round-trips ST, names the content header, and keeps a POU global variable', async () => {
    const client = await boot()
    const projectPath = join(root, 'pump')
    await tool(client.port, client.token, client.session, 'project_create', {
      name: 'Pump',
      path: projectPath,
      language: 'st',
      type: 'plc-project',
      time: 'T#20ms',
    })
    const upserted = await tool(client.port, client.token, client.session, 'pou_upsert', {
      name: 'main',
      pouType: 'program',
      interface: {
        localVars: {
          variable: [
            {
              name: 'running',
              type: { BOOL: '' },
              initialValue: { simpleValue: { value: 'FALSE' } },
              documentation: { 'xhtml:p': ' ' },
            },
          ],
        },
        globalVars: { variable: [{ name: 'shared', type: { INT: '' }, documentation: { 'xhtml:p': ' ' } }] },
      },
      body: { ST: { 'xhtml:p': 'running := TRUE;' } },
      documentation: { 'xhtml:p': 'pump' },
    })
    expect(upserted.ok).toBe(true)
    const exported = await tool(client.port, client.token, client.session, 'program_export_xml', {})
    expect(exported.ok).toBe(true)
    const xml = String(exported.xml)
    expect(xml).toContain('contentHeader')
    expect(xml).toContain('Pump')
    expect(xml).toContain('globalVars')
    expect(xml).toContain('running := TRUE;')
    const applied = await tool(client.port, client.token, client.session, 'program_apply_xml', { xml, mode: 'replace' })
    expect(applied.ok).toBe(true)
    const opened = await tool(client.port, client.token, client.session, 'project_open', { path: projectPath })
    const pous = (opened.content as { pous: PLCPou[] }).pous
    const main = pous.find((pou) => pou.data.name === 'main')
    expect(main?.data.body).toEqual({ language: 'st', value: 'running := TRUE;' })
    expect(main?.data.variables.find((item) => item.name === 'running')?.class).toBe('local')
    expect(main?.data.variables.find((item) => item.name === 'shared')?.class).toBe('global')
    const saved = JSON.parse(await readFile(join(projectPath, 'pous/programs/main.json'), 'utf-8')) as PLCPou
    expect(saved.data.body).toEqual({ language: 'st', value: 'running := TRUE;' })
  })

  it('refuses SFC upserts, restores LD from addData, and exports array global variables', async () => {
    const sfc = projectionToPou({
      name: 'chart',
      pouType: 'program',
      body: { SFC: { 'xhtml:p': 'step' } },
    })
    expect(sfc).toMatchObject({ ok: false, error: { code: 'validation' } })

    const client = await boot()
    const projectPath = join(root, 'graph')
    await tool(client.port, client.token, client.session, 'project_create', {
      name: 'Graph',
      path: projectPath,
      language: 'st',
      type: 'plc-project',
      time: 'T#20ms',
    })
    const opened = await tool(client.port, client.token, client.session, 'project_open', { path: projectPath })
    const bundle = {
      path: projectPath,
      project: (opened.content as { project: ProjectBundle['project'] }).project,
      pous: (opened.content as { pous: PLCPou[] }).pous,
      deviceConfiguration: (opened.content as { deviceConfiguration: ProjectBundle['deviceConfiguration'] }).deviceConfiguration,
      devicePinMapping: (opened.content as { devicePinMapping: ProjectBundle['devicePinMapping'] }).devicePinMapping,
    }
    const first = bundle.pous[0]
    if (!first || first.type !== 'program') throw new Error('expected a program POU')
    bundle.pous = [
      {
        type: 'program',
        data: {
          ...first.data,
          language: 'ld',
          body: {
            language: 'ld',
            value: {
              name: 'main',
              rungs: [
                {
                  id: 'r1',
                  comment: '',
                  defaultBounds: [0, 0],
                  reactFlowViewport: [0, 0, 1],
                  nodes: [],
                  edges: [],
                },
              ],
            },
          },
        },
      },
    ]
    bundle.project = {
      ...bundle.project,
      data: {
        ...bundle.project.data,
        pous: bundle.pous,
        configuration: {
          resource: {
            ...bundle.project.data.configuration.resource,
            globalVariables: [
              variable({
                name: 'counts',
                class: undefined,
                type: {
                  definition: 'array',
                  value: 'int',
                  data: { baseType: { definition: 'base-type', value: 'int' }, dimensions: [{ dimension: '0..3' }] },
                },
              }),
            ],
          },
        },
      },
    }
    const exported = exportProjectXml(bundle)
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    expect(exported.xml).toContain('<array>')
    expect(exported.xml).toContain('<graph>')
    const applied = applyProjectXml(bundle, exported.xml, 'replace')
    expect('warnings' in applied && Array.isArray(applied.warnings)).toBe(true)
    if (!('bundle' in applied)) return
    const main = applied.bundle.pous.find((pou) => pou.data.name === 'main')
    expect(main?.data.body.language).toBe('ld')
    if (main?.data.body.language === 'ld') expect(main.data.body.value.rungs).toHaveLength(1)
    expect(applied.bundle.project.data.configuration.resource.globalVariables[0]?.type.definition).toBe('array')
  })

  it('asks before download and address changes, and refuses save while a job is running', async () => {
    let release: (() => void) | undefined
    const connections: Array<{ ipAddress: string; jwtToken: string | null }> = []
    const client = await boot({
      compileProgram: (_args, port) =>
        new Promise((resolve) => {
          port.start()
          port.postMessage({ logLevel: 'info', message: 'Starting compilation process...' })
          release = () => {
            port.close()
            resolve()
          }
        }),
      renderer: {
        syncProject: () => undefined,
        consoleLog: () => undefined,
        requestApproval: () => {
          approvalCalls += 1
          return Promise.resolve(approvals.length > 0 ? Boolean(approvals.shift()) : false)
        },
        querySnapshot: () => Promise.resolve(null),
        setLockState: () => undefined,
        setRuntimeConnection: (connection) => connections.push(connection),
      },
    })
    const projectPath = join(root, 'pump')
    await tool(client.port, client.token, client.session, 'project_create', {
      name: 'Pump',
      path: projectPath,
      language: 'st',
      type: 'plc-project',
      time: 'T#20ms',
    })
    const started = await tool(client.port, client.token, client.session, 'compile_start', { boardTarget: 'OpenPLC Runtime v4' })
    const busy = await tool(client.port, client.token, client.session, 'project_save')
    expect(busy).toMatchObject({ ok: false, error: { code: 'job-busy' } })
    release?.()
    await waitJob(client.port, client.token, client.session, started.jobId)

    approvals.push(false)
    const denied = await tool(client.port, client.token, client.session, 'pou_upsert', {
      name: 'main',
      pouType: 'program',
      interface: { localVars: { variable: [{ name: 'running', type: { BOOL: '' }, address: '%QX0.0' }] } },
      body: { ST: { 'xhtml:p': 'running := TRUE;' } },
    })
    expect(denied).toMatchObject({ ok: false, error: { code: 'awaiting-approval' } })

    approvals.push(false)
    const download = await tool(client.port, client.token, client.session, 'download_start', { boardTarget: 'OpenPLC Runtime v4' })
    const downloadJob = await waitJob(client.port, client.token, client.session, download.jobId)
    expect(downloadJob.status).toBe('error')
    expect(JSON.stringify(downloadJob.logs)).toContain('awaiting-approval')

    const login = await tool(client.port, client.token, client.session, 'runtime_login', {
      ipAddress: '127.0.0.1',
      username: 'openplc',
      password: 'secret',
    })
    expect(login).toMatchObject({ ok: true, accessToken: 'jwt-test-token' })
    expect(connections[0]).toEqual({ ipAddress: '127.0.0.1', jwtToken: 'jwt-test-token' })
    expect(approvalCalls).toBeGreaterThan(0)
  })

  it('parses VARIABLES.csv and reads mocked debugger values', async () => {
    expect(parseVariablesCsv('0;VAR;running;running;BOOL;\n1;VAR;count;count;INT;\n')).toEqual([
      { index: 0, name: 'running', type: 'BOOL' },
      { index: 1, name: 'count', type: 'INT' },
    ])
    const client = await boot({
      compileForDebugger: async (args, port) => {
        const projectPath = typeof args[0] === 'string' ? args[0] : ''
        const board = typeof args[1] === 'string' ? args[1] : ''
        const file = join(projectPath, 'build', board, 'src', 'VARIABLES.csv')
        await mkdir(join(projectPath, 'build', board, 'src'), { recursive: true })
        await writeFile(file, '0;VAR;running;running;BOOL;\n')
        port.start()
        port.postMessage({ logLevel: 'info', message: 'Starting debug compilation process...' })
        port.close()
      },
    })
    const projectPath = join(root, 'pump')
    await tool(client.port, client.token, client.session, 'project_create', {
      name: 'Pump',
      path: projectPath,
      language: 'st',
      type: 'plc-project',
      time: 'T#20ms',
    })
    const started = await tool(client.port, client.token, client.session, 'debug_compile', { boardTarget: 'OpenPLC Runtime v4' })
    const job = await waitJob(client.port, client.token, client.session, started.jobId)
    expect(job.variables).toEqual([{ index: 0, name: 'running', type: 'BOOL' }])
    const connected = await tool(client.port, client.token, client.session, 'debug_connect', {
      connectionType: 'tcp',
      ipAddress: '127.0.0.1',
    })
    expect(connected.ok).toBe(true)
    const md5 = await tool(client.port, client.token, client.session, 'debug_verify_md5', { expectedMd5: 'abc' })
    expect(md5).toMatchObject({ ok: true, match: true, targetMd5: 'abc' })
    const values = await tool(client.port, client.token, client.session, 'debug_read_variables', { indexes: [0] })
    expect(values).toMatchObject({ ok: true, tick: 7, data: [1] })
    const disconnected = await tool(client.port, client.token, client.session, 'debug_disconnect')
    expect(disconnected.ok).toBe(true)
  })

  it('keeps the agent lock in autonomous mode and skips confirmation', async () => {
    const client = await boot({
      renderer: {
        syncProject: () => undefined,
        consoleLog: () => undefined,
        requestApproval: () => Promise.reject(new Error('autonomous mode must not ask')),
        querySnapshot: () => Promise.resolve(null),
        setLockState: () => undefined,
        setRuntimeConnection: () => undefined,
      },
    })
    await tool(client.port, client.token, client.session, 'session_set_mode', { mode: 'autonomous' })
    const projectPath = join(root, 'pump')
    await tool(client.port, client.token, client.session, 'project_create', {
      name: 'Pump',
      path: projectPath,
      language: 'st',
      type: 'plc-project',
      time: 'T#20ms',
    })
    const upserted = await tool(client.port, client.token, client.session, 'pou_upsert', {
      name: 'main',
      pouType: 'program',
      interface: { localVars: { variable: [{ name: 'running', type: { BOOL: '' }, address: '%QX0.0' }] } },
      body: { ST: { 'xhtml:p': 'running := TRUE;' } },
    })
    expect(upserted.ok).toBe(true)
    const info = await tool(client.port, client.token, client.session, 'session_info')
    expect(info.lock).toMatchObject({ holder: 'agent', mode: 'autonomous' })
    const ctx = new AgentContext(deps(root))
    ctx.session.setMode('autonomous')
    ctx.session.acquireAgentWrite()
    expect(ctx.session.humanLockRequest().readonly).toBe(true)
    expect(ctx.session.holder).toBe('agent')
  })
})
