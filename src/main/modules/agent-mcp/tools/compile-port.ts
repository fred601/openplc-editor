import { LogPort, LogPortMessage } from '../ports'

/** compileProgram closes the port it is given. Also close the paired listener port. */
const proxyPort = (port: LogPort, closePeer: () => void): LogPort => {
  const proxy = {
    start: () => port.start(),
    postMessage: (message: unknown) => port.postMessage(message),
    on(event: 'message' | 'close', listener: ((message: { data: LogPortMessage }) => void) | (() => void)): LogPort {
      if (event === 'message') port.on('message', listener as (message: { data: LogPortMessage }) => void)
      else port.on('close', listener as () => void)
      return proxy
    },
    close: () => {
      port.close()
      closePeer()
    },
  }
  return proxy
}

export { proxyPort }
