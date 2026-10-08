import { useOpenPLCStore } from '@root/renderer/store'
import { DeviceConfiguration, DevicePin } from '@root/types/PLC/devices'
import { PLCPou, PLCProject } from '@root/types/PLC/open-plc'
import { useEffect, useState } from 'react'

type AgentSyncPayload = {
  meta: { path: string }
  content: {
    project: PLCProject
    pous: PLCPou[]
    deviceConfiguration: DeviceConfiguration
    devicePinMapping: DevicePin[]
  }
}

const applyAgentProjectSync = (payload: AgentSyncPayload) => {
  const state = useOpenPLCStore.getState()
  const sameProject = state.project.meta.path !== '' && state.project.meta.path === payload.meta.path
  if (!sameProject) {
    state.sharedWorkspaceActions.clearStatesOnCloseProject()
    state.sharedWorkspaceActions.handleOpenProjectRequest(payload)
  } else {
    state.projectActions.setProject({
      meta: {
        name: payload.content.project.meta.name,
        type: payload.content.project.meta.type,
        path: payload.meta.path,
      },
      data: { ...payload.content.project.data, pous: payload.content.pous },
    })
    state.projectActions.setPous(payload.content.pous)
    state.deviceActions.setDeviceDefinitions({
      configuration: payload.content.deviceConfiguration,
      pinMapping: payload.content.devicePinMapping,
    })
    payload.content.pous.forEach((pou) => {
      if (pou.data.body.language === 'ld') {
        state.ladderFlowActions.addLadderFlow({ ...pou.data.body.value, updated: false } as Parameters<
          typeof state.ladderFlowActions.addLadderFlow
        >[0])
      }
      if (pou.data.body.language === 'fbd') {
        state.fbdFlowActions.addFBDFlow({ ...pou.data.body.value, updated: false } as Parameters<
          typeof state.fbdFlowActions.addFBDFlow
        >[0])
      }
    })
  }
  useOpenPLCStore.getState().workspaceActions.setEditingState('saved')
}

const useAgentMcp = () => {
  const [lock, setLock] = useState<{ readonly: boolean; holder: string | null }>({ readonly: false, holder: null })

  useEffect(() => {
    window.bridge.onAgentProjectSync((_event, payload: AgentSyncPayload) => {
      applyAgentProjectSync(payload)
    })
    window.bridge.onAgentConsoleLog((_event, entry: { level?: 'info' | 'warning' | 'error'; message: string }) => {
      useOpenPLCStore.getState().consoleActions.addLog({
        id: crypto.randomUUID(),
        level: entry.level,
        message: entry.message,
      })
    })
    window.bridge.onAgentApprovalRequest((_event, request: { requestId: string; action: string; message: string }) => {
      useOpenPLCStore.getState().modalActions.openModal('agent-approval', request)
    })
    window.bridge.onAgentLockState((_event, state: { readonly?: boolean; holder?: string | null }) => {
      setLock({ readonly: Boolean(state.readonly), holder: state.holder ?? null })
    })
    window.bridge.onAgentSnapshotRequest((_event, request: { requestId: string }) => {
      const state = useOpenPLCStore.getState()
      if (!state.project.meta.path) {
        window.bridge.agentSnapshotResponse(request.requestId, null)
        return
      }
      window.bridge.agentSnapshotResponse(request.requestId, {
        path: state.project.meta.path,
        project: {
          meta: { name: state.project.meta.name, type: state.project.meta.type },
          data: state.project.data,
        },
        pous: state.project.data.pous,
        deviceConfiguration: state.deviceDefinitions.configuration,
        devicePinMapping: state.deviceDefinitions.pinMapping.pins,
      })
    })
    window.bridge.onAgentRuntimeConnection(
      (_event, connection: { ipAddress: string; jwtToken: string | null }) => {
        const { deviceActions } = useOpenPLCStore.getState()
        deviceActions.setRuntimeIpAddress(connection.ipAddress)
        deviceActions.setRuntimeJwtToken(connection.jwtToken)
        deviceActions.setRuntimeConnectionStatus(connection.jwtToken ? 'connected' : 'disconnected')
      },
    )
  }, [])

  return lock
}

export { useAgentMcp }
