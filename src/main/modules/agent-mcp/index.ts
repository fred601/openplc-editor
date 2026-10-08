import type { BrowserWindow } from 'electron'
import { ipcMain, MessageChannelMain } from 'electron'
import { readFile } from 'fs/promises'

import { ProjectService } from '../../services'
import { CompilerModule } from '../compiler'
import { HardwareModule } from '../hardware'
import { attachAgentIpc } from '../ipc/agent-ipc'
import MainProcessBridge from '../ipc/main'
import { AgentContext } from './context'
import { LogPort } from './ports'
import { startAgentHttpServer } from './server'
import { AgentDeps } from './types'

const electronChannel = (): { port1: LogPort; port2: LogPort } => {
  const channel = new MessageChannelMain()
  return {
    port1: channel.port1 as unknown as LogPort,
    port2: channel.port2 as unknown as LogPort,
  }
}

const startAgentMcp = async (input: {
  version: string
  userDataPath: string
  projectService: ProjectService
  compilerModule: CompilerModule
  hardwareModule: HardwareModule
  bridge: MainProcessBridge
  getWindow: () => BrowserWindow | null
}) => {
  const sessionRef: { current?: AgentContext } = {}
  const renderer = attachAgentIpc(ipcMain, input.getWindow, () => {
    if (!sessionRef.current) throw new Error('Agent MCP session is not ready')
    return sessionRef.current.session
  })

  const deps: AgentDeps = {
    version: input.version,
    userDataPath: input.userDataPath,
    pid: process.pid,
    projectService: {
      createProject: (data) => input.projectService.createProject(data),
      openProjectByPath: (projectPath) => input.projectService.openProjectByPath(projectPath),
      saveProject: (data) => input.projectService.saveProject(data),
      listRecent: async () => {
        const entries = await input.projectService.readProjectHistory(input.projectService.getHistoryProjectsFilePath())
        return entries.map(({ name, path, lastOpenedAt, createdAt }) => ({ name, path, lastOpenedAt, createdAt }))
      },
    },
    compileProgram: (args, port, bridge) => input.compilerModule.compileProgram(args as never, port as never, bridge),
    compileForDebugger: (args, port) => input.compilerModule.compileForDebugger(args, port as never),
    hardware: {
      getAvailableBoards: () => input.hardwareModule.getAvailableBoards(),
      getAvailableSerialPorts: () => input.hardwareModule.getAvailableSerialPorts(),
    },
    readHals: async () => JSON.parse(await readFile(input.compilerModule.halsFilePath, 'utf-8')) as AgentDeps['readHals'] extends () => Promise<infer T> ? T : never,
    runtime: {
      login: async (ipAddress, username, password) =>
        (await input.bridge.handleRuntimeLogin(undefined as never, ipAddress, username, password)) as {
          success: boolean
          accessToken?: string
          error?: string
        },
      status: async (ipAddress, accessToken) => input.bridge.handleRuntimeGetStatus(undefined as never, ipAddress, accessToken),
      start: (ipAddress, accessToken) => input.bridge.handleRuntimeStartPlc(undefined as never, ipAddress, accessToken),
      stop: (ipAddress, accessToken) => input.bridge.handleRuntimeStopPlc(undefined as never, ipAddress, accessToken),
      users: async (ipAddress) => {
        const result = (await input.bridge.handleRuntimeGetUsersInfo(undefined as never, ipAddress)) as {
          hasUsers?: boolean
          error?: string
        }
        return { hasUsers: Boolean(result.hasUsers), error: result.error }
      },
      request: (ipAddress, jwtToken, endpoint, responseParser) =>
        input.bridge.makeRuntimeApiRequest(ipAddress, jwtToken, endpoint, responseParser),
    },
    debugger: {
      connect: (connectionType, params) => input.bridge.handleDebuggerConnect(undefined as never, connectionType, params),
      disconnect: () => input.bridge.handleDebuggerDisconnect(undefined as never),
      verifyMd5: (expectedMd5) => input.bridge.readConnectedDebuggerMd5(expectedMd5),
      readVariables: (indexes) => input.bridge.handleDebuggerGetVariablesList(undefined as never, indexes),
    },
    renderer,
    createChannel: electronChannel,
  }

  sessionRef.current = new AgentContext(deps)
  return startAgentHttpServer(sessionRef.current)
}

export { startAgentMcp }
