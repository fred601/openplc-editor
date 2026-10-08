import { z } from 'zod'

import { AgentContext } from '../context'
import { fail } from '../types'

const loginSchema = z.object({
  ipAddress: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
})

const authedSchema = z.object({
  ipAddress: z.string().min(1),
  accessToken: z.string().min(1),
})

const runtimeLogin = async (ctx: AgentContext, input: unknown) => {
  const parsed = loginSchema.safeParse(input)
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  const result = await ctx.deps.runtime.login(parsed.data.ipAddress, parsed.data.username, parsed.data.password)
  if (!result.success || !result.accessToken) return fail('validation', result.error || 'Runtime login failed.')
  ctx.session.runtimeAuth = { ipAddress: parsed.data.ipAddress, accessToken: result.accessToken }
  ctx.deps.renderer.setRuntimeConnection({ ipAddress: parsed.data.ipAddress, jwtToken: result.accessToken })
  return { ok: true as const, accessToken: result.accessToken }
}

const runtimeStatus = async (ctx: AgentContext, input: unknown) => {
  const parsed = authedSchema.safeParse(input)
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  const result = await ctx.deps.runtime.status(parsed.data.ipAddress, parsed.data.accessToken)
  if (!result.success) return fail('validation', result.error || 'Runtime status failed.')
  return { ok: true as const, status: result.status }
}

const runtimeStart = async (ctx: AgentContext, input: unknown) => {
  const parsed = authedSchema.safeParse(input)
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  const approval = await ctx.approveAction('runtime_start', `Start the PLC at ${parsed.data.ipAddress}?`)
  if (approval) return approval
  const result = await ctx.deps.runtime.start(parsed.data.ipAddress, parsed.data.accessToken)
  if (!result.success) return fail('validation', result.error || 'Failed to start the PLC.')
  return { ok: true as const }
}

const runtimeStop = async (ctx: AgentContext, input: unknown) => {
  const parsed = authedSchema.safeParse(input)
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  const approval = await ctx.approveAction('runtime_stop', `Stop the PLC at ${parsed.data.ipAddress}?`)
  if (approval) return approval
  const result = await ctx.deps.runtime.stop(parsed.data.ipAddress, parsed.data.accessToken)
  if (!result.success) return fail('validation', result.error || 'Failed to stop the PLC.')
  return { ok: true as const }
}

const runtimeUsers = async (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ ipAddress: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return fail('validation', 'ipAddress is required')
  const result = await ctx.deps.runtime.users(parsed.data.ipAddress)
  return { ok: true as const, hasUsers: result.hasUsers, ...(result.error ? { error: result.error } : {}) }
}

export { runtimeLogin, runtimeStart, runtimeStatus, runtimeStop, runtimeUsers }
