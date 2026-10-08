import { join } from 'path'
import { z } from 'zod'

import { AgentContext } from '../context'
import { prepareProjectDataForCompile } from '../python-prepare'
import { bundleToCompileData, fail, isFailure } from '../types'
import { proxyPort } from './compile-port'

const connectSchema = z.object({
  connectionType: z.enum(['tcp', 'rtu']),
  ipAddress: z.string().optional(),
  port: z.string().optional(),
  baudRate: z.number().optional(),
  slaveId: z.number().optional(),
})

const debugCompile = async (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ boardTarget: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return fail('validation', 'boardTarget is required')
  if (parsed.data.boardTarget.includes('..') || parsed.data.boardTarget.includes('/') || parsed.data.boardTarget.includes('\\')) {
    return fail('board-unknown', 'Invalid board target.')
  }
  const hals = await ctx.deps.readHals()
  if (!Object.prototype.hasOwnProperty.call(hals, parsed.data.boardTarget)) {
    return fail('board-unknown', `Unknown board target: ${parsed.data.boardTarget}`)
  }
  const project = ctx.requireProject()
  if (isFailure(project)) return project
  if (ctx.jobs.running) return fail('job-busy', 'A compilation job is already running.')
  const job = ctx.jobs.create()
  job.variablesPath = join(project.path, 'build', parsed.data.boardTarget, 'src', 'VARIABLES.csv')
  ctx.session.activeJobId = job.id
  ctx.session.releaseWriteLock()
  ctx.publishLock()
  const channel = ctx.deps.createChannel()
  ctx.jobs.attach(job, channel.port1, {
    onLog: (log) => ctx.deps.renderer.consoleLog(log),
    onFinish: () => ctx.finishJob(job.id),
  })
  const port = proxyPort(channel.port2, () => channel.port1.close())
  void (async () => {
    try {
      const prepared = prepareProjectDataForCompile(bundleToCompileData(project))
      await ctx.deps.compileForDebugger([project.path, parsed.data.boardTarget, prepared.data], port)
    } catch (error) {
      ctx.jobs.append(job, { logLevel: 'error', message: error instanceof Error ? error.message : String(error) })
      ctx.jobs.finish(job)
      ctx.finishJob(job.id)
    }
  })()
  return { ok: true as const, jobId: job.id }
}

const debugConnect = async (ctx: AgentContext, input: unknown) => {
  const parsed = connectSchema.safeParse(input)
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  const approval = await ctx.approveAction(
    'debug_connect',
    `Connect the Modbus debugger (${parsed.data.connectionType})?`,
  )
  if (approval) return approval
  const result = await ctx.deps.debugger.connect(parsed.data.connectionType, parsed.data)
  if (!result.success) return fail('validation', result.error || 'Debugger connection failed.')
  return { ok: true as const }
}

const debugVerifyMd5 = async (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ expectedMd5: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return fail('validation', 'expectedMd5 is required')
  const result = await ctx.deps.debugger.verifyMd5(parsed.data.expectedMd5)
  if (!result.success) return fail('validation', result.error || 'MD5 verification failed.')
  return { ok: true as const, match: Boolean(result.match), targetMd5: result.targetMd5 ?? '' }
}

const debugReadVariables = async (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ indexes: z.array(z.number().int().nonnegative()) }).safeParse(input)
  if (!parsed.success) return fail('validation', 'indexes must be an array of numbers')
  const result = await ctx.deps.debugger.readVariables(parsed.data.indexes)
  if (!result.success) return fail('validation', result.error || 'Failed to read variables.')
  return {
    ok: true as const,
    tick: result.tick ?? 0,
    lastIndex: result.lastIndex ?? 0,
    data: result.data ?? [],
  }
}

const debugDisconnect = async (ctx: AgentContext) => {
  const result = await ctx.deps.debugger.disconnect()
  if (!result.success) return fail('validation', result.error || 'Disconnect failed.')
  return { ok: true as const }
}

export { debugCompile, debugConnect, debugDisconnect, debugReadVariables, debugVerifyMd5 }
