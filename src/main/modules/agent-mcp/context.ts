import { PLCPou, PLCProject } from '@root/types/PLC/open-plc'
import { unlink } from 'fs/promises'
import { join } from 'path'

import { addressesChanged, deviceChanged, pinsChanged } from './iec-map'
import { JobTable } from './jobs'
import { AgentSession } from './session'
import { AgentDeps, fail, ProjectBundle, ToolFailure } from './types'

const pouPath = (projectPath: string, pou: PLCPou): string => {
  const folder = pou.type === 'function' ? 'functions' : pou.type === 'function-block' ? 'function-blocks' : 'programs'
  return join(projectPath, 'pous', folder, `${pou.data.name}.json`)
}

const projectFileForSave = (bundle: ProjectBundle): PLCProject => ({
  ...bundle.project,
  data: {
    ...bundle.project.data,
    pous: [],
  },
})

class AgentContext {
  readonly session = new AgentSession()
  readonly jobs = new JobTable()

  constructor(readonly deps: AgentDeps) {}

  requireProject(): ProjectBundle | ToolFailure {
    if (!this.session.openProject) return fail('no-project', 'No project is open. Call project_create or project_open.')
    return this.session.openProject
  }

  publishLock(): void {
    this.deps.renderer.setLockState(this.session.lockView())
  }

  guardWrite(): ToolFailure | null {
    if (this.jobs.running) return fail('job-busy', 'A job is running. Save and other writes wait until it finishes.')
    const locked = this.session.acquireAgentWrite()
    if (locked) return locked
    this.publishLock()
    return null
  }

  remember(bundle: ProjectBundle): void {
    this.session.openProject = {
      ...bundle,
      project: {
        ...bundle.project,
        data: { ...bundle.project.data, pous: bundle.pous },
      },
      pous: bundle.pous,
    }
  }

  async persist(bundle: ProjectBundle): Promise<ToolFailure | null> {
    const previous = this.session.openProject
    if (previous && previous.path === bundle.path) {
      const nextKeys = new Set(bundle.pous.map((pou) => `${pou.type}:${pou.data.name}`))
      await Promise.all(
        previous.pous
          .filter((pou) => !nextKeys.has(`${pou.type}:${pou.data.name}`))
          .map(async (pou) => {
            await unlink(pouPath(bundle.path, pou)).catch(() => undefined)
          }),
      )
    }
    const saved = await this.deps.projectService.saveProject({
      projectPath: bundle.path,
      content: {
        projectData: projectFileForSave(bundle),
        pous: bundle.pous,
        deviceConfiguration: bundle.deviceConfiguration,
        devicePinMapping: bundle.devicePinMapping,
      },
    })
    if (!saved.success) return fail('validation', saved.error?.description || 'Failed to save the project.')
    this.remember(bundle)
    this.deps.renderer.syncProject(this.session.openProject as ProjectBundle)
    return null
  }

  async approveSensitive(before: ProjectBundle, after: ProjectBundle, action: string): Promise<ToolFailure | null> {
    const address = addressesChanged(before, after)
    const device = deviceChanged(before.deviceConfiguration, after.deviceConfiguration)
    const pins = pinsChanged(before.devicePinMapping, after.devicePinMapping)
    if (!address && !device && !pins) return null
    const parts = [
      address ? 'variable @address values' : '',
      device ? 'devices/configuration.json' : '',
      pins ? 'the pin table' : '',
    ].filter(Boolean)
    const message = `${action} changes ${parts.join(', ')}.`
    if (this.session.mode === 'autonomous') {
      this.deps.renderer.consoleLog({
        level: 'warning',
        message: `Agent applied ${message} Autonomous mode does not ask for confirmation.`,
      })
      return null
    }
    const approved = await this.deps.renderer.requestApproval({ action, message })
    if (!approved) return fail('awaiting-approval', 'awaiting-approval')
    return null
  }

  async approveAction(action: string, message: string): Promise<ToolFailure | null> {
    if (this.session.mode === 'autonomous') return null
    const approved = await this.deps.renderer.requestApproval({ action, message })
    if (!approved) return fail('awaiting-approval', 'awaiting-approval')
    return null
  }

  finishJob(jobId: string): void {
    if (this.session.activeJobId === jobId) this.session.activeJobId = null
  }
}

export { AgentContext, pouPath }
