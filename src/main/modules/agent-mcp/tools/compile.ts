import { join } from 'path'
import { z } from 'zod'

import { AgentContext } from '../context'
import { LogPort } from '../ports'
import { prepareProjectDataForCompile } from '../python-prepare'
import { bundleToCompileData, fail, isFailure, ProjectBundle } from '../types'
import { proxyPort } from './compile-port'

const boardSchema = z.object({
  boardTarget: z.string().min(1),
  compileOnly: z.boolean().optional(),
})

const boardCore = (boards: Map<string, { core?: string }> | Record<string, { core?: string }>, name: string): string | null => {
  if (boards instanceof Map) return boards.get(name)?.core ?? null
  return boards[name]?.core ?? null
}

const assertBoard = async (ctx: AgentContext, boardTarget: string) => {
  if (boardTarget.includes('..') || boardTarget.includes('/') || boardTarget.includes('\\')) {
    return fail('board-unknown', 'Invalid board target.')
  }
  const hals = await ctx.deps.readHals()
  if (!Object.prototype.hasOwnProperty.call(hals, boardTarget)) {
    return fail('board-unknown', `Unknown board target: ${boardTarget}`)
  }
  return hals
}

const startJob = (
  ctx: AgentContext,
  project: ProjectBundle,
  boardTarget: string,
  _compileOnly: boolean,
  kind: 'compile' | 'debug',
) => {
  if (ctx.jobs.running) return fail('job-busy', 'A compilation job is already running.')
  const job = ctx.jobs.create()
  if (kind === 'debug') {
    job.variablesPath = join(project.path, 'build', boardTarget, 'src', 'VARIABLES.csv')
  }
  ctx.session.activeJobId = job.id
  ctx.session.releaseWriteLock()
  ctx.publishLock()
  const channel = ctx.deps.createChannel()
  ctx.jobs.attach(job, channel.port1, {
    onLog: (log) => ctx.deps.renderer.consoleLog(log),
    onFinish: () => ctx.finishJob(job.id),
  })
  const port = proxyPort(channel.port2, () => channel.port1.close())
  return { ok: true as const, jobId: job.id, job, port }
}

const runCompile = async (ctx: AgentContext, project: ProjectBundle, boardTarget: string, compileOnly: boolean, port: LogPort) => {
  const prepared = prepareProjectDataForCompile(bundleToCompileData(project))
  for (const warning of prepared.warnings) {
    ctx.deps.renderer.consoleLog({ level: 'warning', message: warning })
  }
  let core: string | null = null
  try {
    core = boardCore(await ctx.deps.hardware.getAvailableBoards(), boardTarget)
  } catch (error) {
    core = null
    ctx.deps.renderer.consoleLog({
      level: 'warning',
      message: `Board core lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  const ip = ctx.session.runtimeAuth?.ipAddress ?? project.deviceConfiguration.runtimeIpAddress ?? null
  const token = ctx.session.runtimeAuth?.accessToken ?? null
  await ctx.deps.compileProgram(
    [project.path, boardTarget, core, compileOnly, prepared.data, ip, token],
    port,
    { makeRuntimeApiRequest: ctx.deps.runtime.request },
  )
}

const compileStart = async (ctx: AgentContext, input: unknown) => {
  const parsed = boardSchema.safeParse(input)
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  if (parsed.data.compileOnly === false) {
    return fail('validation', 'compile_start always uses compileOnly=true. Call download_start to upload.')
  }
  const project = ctx.requireProject()
  if (isFailure(project)) return project
  const board = await assertBoard(ctx, parsed.data.boardTarget)
  if (isFailure(board)) return board
  const started = startJob(ctx, project, parsed.data.boardTarget, true, 'compile')
  if (isFailure(started)) return started
  void runCompile(ctx, project, parsed.data.boardTarget, true, started.port).catch((error: unknown) => {
    ctx.jobs.append(started.job, { logLevel: 'error', message: error instanceof Error ? error.message : String(error) })
    ctx.jobs.finish(started.job)
    ctx.finishJob(started.job.id)
  })
  return { ok: true as const, jobId: started.jobId }
}

const downloadStart = async (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ boardTarget: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  const project = ctx.requireProject()
  if (isFailure(project)) return project
  const board = await assertBoard(ctx, parsed.data.boardTarget)
  if (isFailure(board)) return board
  const started = startJob(ctx, project, parsed.data.boardTarget, false, 'compile')
  if (isFailure(started)) return started
  void (async () => {
    try {
      if (ctx.session.mode === 'supervised') {
        const approved = await ctx.deps.renderer.requestApproval({
          action: 'download_start',
          message: `Upload the program to ${parsed.data.boardTarget}?`,
        })
        if (!approved) {
          ctx.jobs.append(started.job, { logLevel: 'error', message: 'awaiting-approval' })
          ctx.jobs.finish(started.job)
          ctx.finishJob(started.job.id)
          return
        }
      }
      await runCompile(ctx, project, parsed.data.boardTarget, false, started.port)
    } catch (error) {
      ctx.jobs.append(started.job, { logLevel: 'error', message: error instanceof Error ? error.message : String(error) })
      ctx.jobs.finish(started.job)
      ctx.finishJob(started.job.id)
    }
  })()
  return { ok: true as const, jobId: started.jobId }
}

const jobGet = (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ jobId: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return fail('validation', 'jobId is required')
  const job = ctx.jobs.get(parsed.data.jobId)
  if (!job) return fail('not-found', `Unknown job ${parsed.data.jobId}`)
  return {
    ok: true as const,
    status: job.status,
    logs: job.logs,
    ...(job.plcStatus ? { plcStatus: job.plcStatus } : {}),
    ...(job.variables ? { variables: job.variables } : {}),
  }
}

const hardwareBoards = async (ctx: AgentContext) => {
  let boards: Awaited<ReturnType<AgentContext['deps']['hardware']['getAvailableBoards']>>
  try {
    boards = await ctx.deps.hardware.getAvailableBoards()
  } catch (error) {
    return fail('validation', error instanceof Error ? error.message : 'Failed to list boards.')
  }
  const hals = await ctx.deps.readHals()
  const names = new Set<string>([...Object.keys(hals), ...(boards instanceof Map ? boards.keys() : Object.keys(boards))])
  const result: Record<string, { core?: string; compiler?: string; pins?: unknown; specs?: unknown }> = {}
  for (const name of names) {
    const fromBoards = boards instanceof Map ? boards.get(name) : boards[name]
    const fromHals = hals[name]
    result[name] = {
      core: fromBoards?.core ?? fromHals?.core,
      compiler: fromHals?.compiler,
      pins: fromBoards?.pins ?? fromHals?.pins,
      specs: fromBoards?.specs ?? fromHals?.specs,
    }
  }
  return { ok: true as const, boards: result }
}

const hardwarePorts = async (ctx: AgentContext) => {
  try {
    const ports = await ctx.deps.hardware.getAvailableSerialPorts()
    return { ok: true as const, ports }
  } catch (error) {
    return fail('validation', error instanceof Error ? error.message : 'Failed to list serial ports.')
  }
}

export { compileStart, downloadStart, hardwareBoards, hardwarePorts, jobGet }
