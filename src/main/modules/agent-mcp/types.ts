import { DeviceConfiguration, DevicePin } from '@root/types/PLC/devices'
import { PLCPou, PLCProject, PLCProjectData } from '@root/types/PLC/open-plc'

import { LogPort } from './ports'

const AGENT_MCP_PROTOCOL_VERSION = '2025-03-26'
const APPROVAL_TIMEOUT_MS = 60_000
const SNAPSHOT_TIMEOUT_MS = 1_500

type AgentMode = 'supervised' | 'autonomous'
type LockHolder = 'human' | 'agent' | null

type ToolErrorCode =
  | 'unauthorized'
  | 'locked-by-human'
  | 'job-busy'
  | 'validation'
  | 'main-pou-missing'
  | 'board-unknown'
  | 'awaiting-approval'
  | 'not-found'
  | 'no-project'

type ToolError = { code: ToolErrorCode; message: string }
type ToolFailure = { ok: false; error: ToolError }

const fail = (code: ToolErrorCode, message: string): ToolFailure => ({
  ok: false,
  error: { code, message },
})

const isFailure = (value: unknown): value is ToolFailure => {
  if (!value || typeof value !== 'object') return false
  const record = value as { ok?: unknown; error?: { code?: unknown; message?: unknown } }
  return record.ok === false && typeof record.error?.code === 'string' && typeof record.error?.message === 'string'
}

type ProjectBundle = {
  path: string
  project: PLCProject
  pous: PLCPou[]
  deviceConfiguration: DeviceConfiguration
  devicePinMapping: DevicePin[]
}

const bundleToCompileData = (bundle: ProjectBundle): PLCProjectData => ({
  ...bundle.project.data,
  pous: bundle.pous,
})

type BoardInfo = {
  core?: string
  preview?: string
  specs?: unknown
  pins?: unknown
  coreVersion?: string
}

type RecentProject = {
  name: string
  path: string
  lastOpenedAt: string
  createdAt: string
}

type RuntimeLoginResult = { success: boolean; accessToken?: string; error?: string }
type RuntimeStatusResult = { success: boolean; status?: string; error?: string }
type RuntimeActionResult = { success: boolean; error?: string }
type RuntimeUsersResult = { hasUsers: boolean; error?: string }

type AgentDeps = {
  version: string
  userDataPath: string
  pid: number
  projectService: {
    createProject: (data: {
      language: 'il' | 'st' | 'ld' | 'sfc' | 'fbd'
      time: string
      type: 'plc-project' | 'plc-library'
      name: string
      path: string
    }) => Promise<{
      success: boolean
      error?: { title?: string; description?: string }
      data?: {
        meta: { path: string }
        content: {
          project: PLCProject
          pous: PLCPou[]
          deviceConfiguration: DeviceConfiguration
          devicePinMapping: DevicePin[]
        }
      }
    }>
    openProjectByPath: (projectPath: string) => Promise<{
      success: boolean
      error?: { title?: string; description?: string }
      data?: {
        meta: { path: string }
        content: {
          project: PLCProject
          pous: PLCPou[]
          deviceConfiguration: DeviceConfiguration
          devicePinMapping: DevicePin[]
        }
      }
    }>
    saveProject: (data: {
      projectPath: string
      content: {
        projectData: PLCProject
        pous: PLCPou[]
        deviceConfiguration: DeviceConfiguration
        devicePinMapping: DevicePin[]
      }
    }) => Promise<{ success: boolean; error?: { description?: string } }>
    listRecent: () => Promise<RecentProject[]>
  }
  compileProgram: (
    args: Array<string | boolean | null | PLCProjectData>,
    port: LogPort,
    bridge: {
      makeRuntimeApiRequest: <T = void>(
        ipAddress: string,
        jwtToken: string,
        endpoint: string,
        responseParser?: (data: string) => T,
      ) => Promise<{ success: true; data?: T } | { success: false; error: string }>
    },
  ) => Promise<void>
  compileForDebugger: (args: Array<string | null | PLCProjectData>, port: LogPort) => Promise<void>
  hardware: {
    getAvailableBoards: () => Promise<Map<string, BoardInfo> | Record<string, BoardInfo>>
    getAvailableSerialPorts: () => Promise<string[]>
  }
  readHals: () => Promise<Record<string, { compiler?: string; core?: string; pins?: unknown; specs?: unknown }>>
  runtime: {
    login: (ipAddress: string, username: string, password: string) => Promise<RuntimeLoginResult>
    status: (ipAddress: string, accessToken: string) => Promise<RuntimeStatusResult>
    start: (ipAddress: string, accessToken: string) => Promise<RuntimeActionResult>
    stop: (ipAddress: string, accessToken: string) => Promise<RuntimeActionResult>
    users: (ipAddress: string) => Promise<RuntimeUsersResult>
    request: <T = void>(
      ipAddress: string,
      jwtToken: string,
      endpoint: string,
      responseParser?: (data: string) => T,
    ) => Promise<{ success: true; data?: T } | { success: false; error: string }>
  }
  debugger: {
    connect: (
      connectionType: 'tcp' | 'rtu',
      params: { ipAddress?: string; port?: string; baudRate?: number; slaveId?: number },
    ) => Promise<{ success: boolean; error?: string }>
    disconnect: () => Promise<{ success: boolean; error?: string }>
    verifyMd5: (expectedMd5: string) => Promise<{ success: boolean; match?: boolean; targetMd5?: string; error?: string }>
    readVariables: (indexes: number[]) => Promise<{
      success: boolean
      tick?: number
      lastIndex?: number
      data?: number[]
      error?: string
    }>
  }
  renderer: {
    syncProject: (bundle: ProjectBundle) => void
    consoleLog: (entry: { level: 'info' | 'warning' | 'error'; message: string }) => void
    requestApproval: (request: { action: string; message: string }) => Promise<boolean>
    querySnapshot: () => Promise<ProjectBundle | null>
    setLockState: (state: { holder: LockHolder; mode: AgentMode; readonly: boolean }) => void
    setRuntimeConnection: (connection: { ipAddress: string; jwtToken: string | null }) => void
  }
  createChannel: () => { port1: LogPort; port2: LogPort }
}

export {
  AGENT_MCP_PROTOCOL_VERSION,
  APPROVAL_TIMEOUT_MS,
  bundleToCompileData,
  fail,
  isFailure,
  SNAPSHOT_TIMEOUT_MS,
}
export type {
  AgentDeps,
  AgentMode,
  BoardInfo,
  LockHolder,
  ProjectBundle,
  RecentProject,
  ToolError,
  ToolErrorCode,
  ToolFailure,
}
