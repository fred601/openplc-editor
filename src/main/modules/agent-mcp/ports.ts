import { EventEmitter } from 'events'

type LogPortMessage = {
  logLevel?: 'info' | 'warning' | 'error' | 'warn'
  message?: string | Buffer
  plcStatus?: string
  closePort?: boolean
}

interface LogPort {
  start(): void
  close(): void
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: LogPortMessage }) => void): LogPort
  on(event: 'close', listener: () => void): LogPort
}

/**
 * In-process pair with the same start/postMessage/close contract as Electron's
 * MessageChannelMain. Tests use this. The app uses MessageChannelMain and only
 * needs those three methods, which compileProgram already calls.
 */
class LinkedPort extends EventEmitter implements LogPort {
  peer: LinkedPort | null = null
  private started = false
  private closed = false
  private queue: unknown[] = []

  start(): void {
    if (this.closed) return
    this.started = true
    const queued = this.queue.splice(0)
    for (const message of queued) {
      this.emit('message', { data: message })
    }
  }

  postMessage(message: unknown): void {
    if (this.closed || !this.peer || this.peer.closed) return
    if (!this.peer.started) {
      this.peer.queue.push(message)
      return
    }
    this.peer.emit('message', { data: message })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

const createLinkedPorts = (): { port1: LogPort; port2: LogPort } => {
  const port1 = new LinkedPort()
  const port2 = new LinkedPort()
  port1.peer = port2
  port2.peer = port1
  return { port1, port2 }
}

const unwrapLogMessage = (event: unknown): LogPortMessage => {
  if (!event || typeof event !== 'object') return {}
  const record = event as { data?: unknown; logLevel?: unknown; message?: unknown }
  if ('data' in record && record.logLevel === undefined && record.message === undefined) {
    const data = record.data
    if (data && typeof data === 'object') return data as LogPortMessage
  }
  return record as LogPortMessage
}

export { createLinkedPorts, unwrapLogMessage }
export type { LogPort, LogPortMessage }
