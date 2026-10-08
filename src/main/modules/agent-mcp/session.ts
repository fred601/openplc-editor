import { AgentMode, fail, LockHolder, ProjectBundle, ToolFailure } from './types'

type LockView = { holder: LockHolder; mode: AgentMode; readonly: boolean }

class AgentSession {
  mode: AgentMode = 'supervised'
  holder: LockHolder = null
  openProject: ProjectBundle | null = null
  activeJobId: string | null = null
  runtimeAuth: { ipAddress: string; accessToken: string } | null = null

  info(version: string) {
    return {
      version,
      openProjectPath: this.openProject?.path ?? null,
      lock: { holder: this.holder, mode: this.mode },
      activeJobId: this.activeJobId,
    }
  }

  setMode(mode: AgentMode): { ok: true; mode: AgentMode } {
    this.mode = mode
    return { ok: true, mode }
  }

  release(): { ok: true } {
    this.holder = null
    return { ok: true }
  }

  /**
   * supervised: the person takes the lock.
   * autonomous: an agent that already holds the lock keeps it.
   */
  humanLockRequest(): LockView {
    if (this.mode === 'supervised' || this.holder !== 'agent') {
      this.holder = 'human'
    }
    return this.lockView()
  }

  acquireAgentWrite(): ToolFailure | null {
    if (this.mode === 'supervised' && this.holder === 'human') {
      return fail('locked-by-human', 'A person is editing this project. Wait, or ask them to save and release the lock.')
    }
    this.holder = 'agent'
    return null
  }

  releaseWriteLock(): void {
    this.holder = null
  }

  releaseAfterSave(hasRunningJob: boolean): void {
    if (!hasRunningJob) this.holder = null
  }

  lockView(): LockView {
    return {
      holder: this.holder,
      mode: this.mode,
      readonly: this.mode === 'autonomous' && this.holder === 'agent',
    }
  }
}

export { AgentSession }
export type { LockView }
