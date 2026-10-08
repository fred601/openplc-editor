import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'

import { LogPort, LogPortMessage, unwrapLogMessage } from './ports'
import { parseVariablesCsv } from './variables-csv'

type JobStatus = 'running' | 'success' | 'error'
type JobLevel = 'info' | 'warning' | 'error'

type JobLog = { level: JobLevel; message: string }

type DebugVariable = { index: number; name: string; type: string }

type JobRecord = {
  id: string
  status: JobStatus
  logs: JobLog[]
  plcStatus?: string
  variables?: DebugVariable[]
  variablesPath?: string
}

const normalizeLevel = (level: LogPortMessage['logLevel']): JobLevel => {
  if (level === 'error') return 'error'
  if (level === 'warning' || level === 'warn') return 'warning'
  return 'info'
}

const normalizeMessage = (message: LogPortMessage['message']): string => {
  if (message == null) return ''
  if (typeof message === 'string') return message
  return message.toString('utf-8')
}

class JobTable {
  private jobs = new Map<string, JobRecord>()

  get running(): JobRecord | undefined {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') return job
    }
    return undefined
  }

  create(): JobRecord {
    const job: JobRecord = { id: randomUUID(), status: 'running', logs: [] }
    this.jobs.set(job.id, job)
    return job
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id)
  }

  append(job: JobRecord, entry: LogPortMessage): JobLog | null {
    if (entry.plcStatus) job.plcStatus = entry.plcStatus
    const message = normalizeMessage(entry.message)
    if (!message) return null
    const log = { level: normalizeLevel(entry.logLevel), message }
    job.logs.push(log)
    return log
  }

  finish(job: JobRecord): void {
    if (job.status !== 'running') return
    if (job.variablesPath && !job.variables) {
      try {
        job.variables = parseVariablesCsv(readFileSync(job.variablesPath, 'utf-8'))
      } catch {
        job.variables = []
      }
    }
    const lastError = [...job.logs].reverse().find((log) => log.level === 'error')
    job.status = lastError ? 'error' : 'success'
  }

  attach(
    job: JobRecord,
    port: LogPort,
    hooks?: { onLog?: (log: JobLog) => void; onFinish?: (job: JobRecord) => void },
  ): void {
    port.start()
    port.on('message', (event) => {
      const data = unwrapLogMessage(event)
      const log = this.append(job, data)
      if (log) hooks?.onLog?.(log)
      if (data.closePort) {
        this.finish(job)
        hooks?.onFinish?.(job)
        port.close()
      }
    })
    port.on('close', () => {
      const wasRunning = job.status === 'running'
      this.finish(job)
      if (wasRunning) hooks?.onFinish?.(job)
    })
  }
}

export { JobTable }
export type { DebugVariable, JobLog, JobRecord, JobStatus }
