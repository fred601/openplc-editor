import { z } from 'zod'

import { AgentContext } from '../context'
import { fail, ProjectBundle } from '../types'

const createSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  language: z.enum(['il', 'st', 'ld', 'sfc', 'fbd']),
  type: z.enum(['plc-project', 'plc-library']),
  time: z.string().min(1),
})

const projectCreate = async (ctx: AgentContext, input: unknown) => {
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  const created = await ctx.deps.projectService.createProject(parsed.data)
  if (!created.success || !created.data) {
    return fail('validation', created.error?.description || created.error?.title || 'Failed to create the project.')
  }
  const createdContent = created.data.content
  const bundle: ProjectBundle = {
    path: created.data.meta.path,
    project: createdContent.project,
    pous: createdContent.pous,
    deviceConfiguration: createdContent.deviceConfiguration,
    devicePinMapping: createdContent.devicePinMapping,
  }
  ctx.remember(bundle)
  ctx.deps.renderer.syncProject(bundle)
  return { ok: true as const, projectPath: bundle.path }
}

const projectOpen = async (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ path: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  const opened = await ctx.deps.projectService.openProjectByPath(parsed.data.path)
  if (!opened.success || !opened.data) {
    return fail('validation', opened.error?.description || opened.error?.title || 'Failed to open the project.')
  }
  const openedContent = opened.data.content
  const bundle: ProjectBundle = {
    path: opened.data.meta.path,
    project: openedContent.project,
    pous: openedContent.pous,
    deviceConfiguration: openedContent.deviceConfiguration,
    devicePinMapping: openedContent.devicePinMapping,
  }
  ctx.remember(bundle)
  ctx.deps.renderer.syncProject(bundle)
  return { ok: true as const, meta: { path: bundle.path, name: bundle.project.meta.name, type: bundle.project.meta.type }, content: opened.data.content }
}

const projectSave = async (ctx: AgentContext) => {
  if (ctx.jobs.running) return fail('job-busy', 'A job is running. project_save waits until it finishes.')
  const locked = ctx.session.acquireAgentWrite()
  if (locked) return locked
  ctx.publishLock()
  const snapshot = await ctx.deps.renderer.querySnapshot()
  const bundle = snapshot ?? ctx.session.openProject
  if (!bundle?.path) return fail('no-project', 'No project is open.')
  const saved = await ctx.persist(bundle)
  if (saved) return saved
  ctx.session.releaseAfterSave(Boolean(ctx.jobs.running))
  ctx.publishLock()
  return { ok: true as const }
}

const projectListRecent = async (ctx: AgentContext) => {
  const projects = await ctx.deps.projectService.listRecent()
  return { ok: true as const, projects }
}

export { projectCreate, projectListRecent, projectOpen, projectSave }
