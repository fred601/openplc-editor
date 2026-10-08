import { PLCDataType } from '@root/types/PLC/open-plc'
import { z } from 'zod'

import { AgentContext } from '../context'
import {
  applyProjectXml,
  dataTypeFromIec,
  exportProjectXml,
  pouToProjection,
  projectionToPou,
  resourceFromProjection,
  resourceToProjection,
} from '../iec-map'
import { fail, isFailure } from '../types'

const requireWritableProject = (ctx: AgentContext) => {
  const locked = ctx.guardWrite()
  if (locked) return locked
  return ctx.requireProject()
}

const programExportXml = (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ dialect: z.enum(['old-editor', 'codesys']).optional() }).safeParse(input ?? {})
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  const project = ctx.requireProject()
  if (isFailure(project)) return project
  return exportProjectXml(project, parsed.data.dialect ?? 'old-editor')
}

const programApplyXml = async (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ xml: z.string().min(1), mode: z.enum(['replace', 'merge']) }).safeParse(input)
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  const project = requireWritableProject(ctx)
  if (isFailure(project)) return project
  const applied = applyProjectXml(project, parsed.data.xml, parsed.data.mode)
  if (isFailure(applied)) return applied
  const approval = await ctx.approveSensitive(project, applied.bundle, 'program_apply_xml')
  if (approval) {
    ctx.session.release()
    ctx.publishLock()
    return approval
  }
  const saved = await ctx.persist(applied.bundle)
  if (saved) return saved
  return { ok: true as const, warnings: applied.warnings }
}

const pouList = (ctx: AgentContext) => {
  const project = ctx.requireProject()
  if (isFailure(project)) return project
  return {
    ok: true as const,
    pous: project.pous.map((pou) => ({ name: pou.data.name, pouType: pou.type, language: pou.data.language })),
  }
}

const pouGet = (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ name: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return fail('validation', 'name is required')
  const project = ctx.requireProject()
  if (isFailure(project)) return project
  const pou = project.pous.find((item) => item.data.name === parsed.data.name)
  if (!pou) return fail('not-found', `POU "${parsed.data.name}" was not found.`)
  const projected = pouToProjection(pou)
  return { ok: true as const, pou: projected.pou, warnings: projected.warnings }
}

const pouUpsert = async (ctx: AgentContext, input: unknown) => {
  const project = requireWritableProject(ctx)
  if (isFailure(project)) return project
  const converted = projectionToPou(input)
  if (isFailure(converted)) return converted
  const nextPous = project.pous.filter((pou) => pou.data.name !== converted.pou.data.name)
  nextPous.push(converted.pou)
  const next = { ...project, pous: nextPous, project: { ...project.project, data: { ...project.project.data, pous: nextPous } } }
  const approval = await ctx.approveSensitive(project, next, 'pou_upsert')
  if (approval) {
    ctx.session.release()
    ctx.publishLock()
    return approval
  }
  const saved = await ctx.persist(next)
  if (saved) return saved
  return { ok: true as const, warnings: converted.warnings }
}

const pouDelete = async (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ name: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return fail('validation', 'name is required')
  if (parsed.data.name === 'main') return fail('validation', 'The main program cannot be deleted. Compilation requires it.')
  const project = requireWritableProject(ctx)
  if (isFailure(project)) return project
  const next = {
    ...project,
    pous: project.pous.filter((pou) => pou.data.name !== parsed.data.name),
  }
  const saved = await ctx.persist(next)
  if (saved) return saved
  return { ok: true as const }
}

const datatypeUpsert = async (ctx: AgentContext, input: unknown) => {
  const project = requireWritableProject(ctx)
  if (isFailure(project)) return project
  const dataType = dataTypeFromIec(input)
  if (!dataType) return fail('validation', 'dataType could not be mapped onto array, enumerated, or structure.')
  const dataTypes = project.project.data.dataTypes.filter((item) => item.name !== dataType.name)
  dataTypes.push(dataType)
  const next = {
    ...project,
    project: { ...project.project, data: { ...project.project.data, dataTypes } },
  }
  const saved = await ctx.persist(next)
  if (saved) return saved
  return { ok: true as const }
}

const datatypeDelete = async (ctx: AgentContext, input: unknown) => {
  const parsed = z.object({ name: z.string().min(1) }).safeParse(input)
  if (!parsed.success) return fail('validation', 'name is required')
  const project = requireWritableProject(ctx)
  if (isFailure(project)) return project
  const dataTypes = project.project.data.dataTypes.filter((item: PLCDataType) => item.name !== parsed.data.name)
  const next = { ...project, project: { ...project.project, data: { ...project.project.data, dataTypes } } }
  const saved = await ctx.persist(next)
  if (saved) return saved
  return { ok: true as const }
}

const resourceGet = (ctx: AgentContext) => {
  const project = ctx.requireProject()
  if (isFailure(project)) return project
  const resource = resourceToProjection(project.project.data.configuration)
  return { ok: true as const, ...resource }
}

const resourceApply = async (ctx: AgentContext, input: unknown) => {
  const parsed = z
    .object({
      tasks: z.array(z.unknown()).optional(),
      pouInstances: z.array(z.unknown()).optional(),
      globalVars: z.array(z.unknown()).optional(),
    })
    .safeParse(input)
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  const project = requireWritableProject(ctx)
  if (isFailure(project)) return project
  const resource = resourceFromProjection(parsed.data)
  if (isFailure(resource)) return resource
  const next = {
    ...project,
    project: { ...project.project, data: { ...project.project.data, configuration: resource.configuration } },
  }
  const approval = await ctx.approveSensitive(project, next, 'resource_apply')
  if (approval) {
    ctx.session.release()
    ctx.publishLock()
    return approval
  }
  const saved = await ctx.persist(next)
  if (saved) return saved
  return { ok: true as const, warnings: resource.warnings }
}

export {
  datatypeDelete,
  datatypeUpsert,
  pouDelete,
  pouGet,
  pouList,
  pouUpsert,
  programApplyXml,
  programExportXml,
  resourceApply,
  resourceGet,
}
