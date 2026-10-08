import { randomUUID } from 'crypto'
import type { BrowserWindow, IpcMain } from 'electron'

import { AgentSession } from '../agent-mcp/session'
import { APPROVAL_TIMEOUT_MS, ProjectBundle, SNAPSHOT_TIMEOUT_MS } from '../agent-mcp/types'

const toSyncPayload = (bundle: ProjectBundle) => ({
  meta: { path: bundle.path },
  content: {
    project: bundle.project,
    pous: bundle.pous,
    deviceConfiguration: bundle.deviceConfiguration,
    devicePinMapping: bundle.devicePinMapping,
  },
})

const attachAgentIpc = (ipcMain: IpcMain, getWindow: () => BrowserWindow | null, getSession: () => AgentSession) => {
  const approvals = new Map<string, { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }>()
  const snapshots = new Map<string, { resolve: (bundle: ProjectBundle | null) => void; timer: NodeJS.Timeout }>()

  ipcMain.on('agent:lock-request', () => {
    const view = getSession().humanLockRequest()
    getWindow()?.webContents.send('agent:lock-state', view)
  })

  ipcMain.on('agent:approval-response', (_event, payload: { requestId?: string; approved?: boolean }) => {
    if (!payload?.requestId) return
    const pending = approvals.get(payload.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    approvals.delete(payload.requestId)
    pending.resolve(payload.approved === true)
  })

  ipcMain.on('agent:snapshot-response', (_event, payload: { requestId?: string; snapshot?: ProjectBundle | null }) => {
    if (!payload?.requestId) return
    const pending = snapshots.get(payload.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    snapshots.delete(payload.requestId)
    pending.resolve(payload.snapshot ?? null)
  })

  return {
    syncProject: (bundle: ProjectBundle) => {
      getWindow()?.webContents.send('agent:project-sync', toSyncPayload(bundle))
    },
    consoleLog: (entry: { level: 'info' | 'warning' | 'error'; message: string }) => {
      getWindow()?.webContents.send('agent:console-log', entry)
    },
    requestApproval: (request: { action: string; message: string }) =>
      new Promise<boolean>((resolve) => {
        const window = getWindow()
        if (!window) {
          resolve(false)
          return
        }
        const requestId = randomUUID()
        const timer = setTimeout(() => {
          approvals.delete(requestId)
          resolve(false)
        }, APPROVAL_TIMEOUT_MS)
        approvals.set(requestId, { resolve, timer })
        window.webContents.send('agent:approval-request', { requestId, ...request })
      }),
    querySnapshot: () =>
      new Promise<ProjectBundle | null>((resolve) => {
        const window = getWindow()
        if (!window) {
          resolve(null)
          return
        }
        const requestId = randomUUID()
        const timer = setTimeout(() => {
          snapshots.delete(requestId)
          resolve(null)
        }, SNAPSHOT_TIMEOUT_MS)
        snapshots.set(requestId, { resolve, timer })
        window.webContents.send('agent:snapshot-request', { requestId })
      }),
    setLockState: (state: { holder: 'human' | 'agent' | null; mode: 'supervised' | 'autonomous'; readonly: boolean }) => {
      getWindow()?.webContents.send('agent:lock-state', state)
    },
    setRuntimeConnection: (connection: { ipAddress: string; jwtToken: string | null }) => {
      getWindow()?.webContents.send('agent:runtime-connection', connection)
    },
  }
}

export { attachAgentIpc }
