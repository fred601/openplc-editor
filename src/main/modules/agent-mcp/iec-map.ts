import { DeviceConfiguration, deviceConfigurationSchema, DevicePin, devicePinSchema } from '@root/types/PLC/devices'
import {
  baseTypeSchema,
  PLCConfiguration,
  PLCDataType,
  PLCDataTypeSchema,
  PLCInstance,
  PLCPou,
  PLCPouSchema,
  PLCTask,
  PLCVariable,
} from '@root/types/PLC/open-plc'
import { XmlGenerator } from '@root/utils/PLC/xml-generator'
import { create } from 'xmlbuilder2'

import { bundleToCompileData, fail, isFailure, ProjectBundle, ToolFailure } from './types'

type BaseTypeName = (typeof baseTypeSchema.options)[number]
const BASE_TYPES = new Set<string>(baseTypeSchema.options)
const OPENPLC_DATA_NAME = 'http://www.openplcproject.com/xml/openplc'

type WarningList = string[]

type IecVariable = {
  name: string
  address?: string
  type: Record<string, unknown>
  initialValue?: { simpleValue: { value: string } }
  documentation?: { 'xhtml:p': string }
  debug?: boolean
}

type IecPou = {
  name: string
  pouType: 'program' | 'function' | 'functionBlock'
  interface?: Record<string, unknown>
  body?: Record<string, unknown>
  documentation?: { 'xhtml:p': string }
  addData?: {
    openplc?: {
      graph?: unknown
      language?: string
      source?: string
      debug?: Record<string, boolean>
    }
  }
}

type IecResource = {
  tasks: Array<Record<string, unknown>>
  pouInstances: Array<{ name: string; typeName: string; task?: string }>
  globalVars: IecVariable[]
  warnings: WarningList
}

const asArray = <T>(value: T | T[] | undefined | null): T[] => {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const textOf = (node: unknown): string => {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node)
  if (!isRecord(node)) return ''
  if (typeof node['#'] === 'string') return node['#']
  if (typeof node.$ === 'string') return node.$
  if ('xhtml:p' in node) return textOf(node['xhtml:p'])
  return ''
}

const attr = (node: Record<string, unknown>, name: string): string => {
  const value = node[`@${name}`] ?? node[name]
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

const editorTypeToIec = (type: PLCVariable['type']): Record<string, unknown> => {
  if (type.definition === 'array') {
    return {
      array: {
        dimension: type.data.dimensions.map((dimension) => {
          const [lower, upper] = dimension.dimension.split('..')
          return { lower: lower ?? '', upper: upper ?? '' }
        }),
        baseType: iecBase(type.data.baseType),
      },
    }
  }
  if (type.definition === 'derived' || type.definition === 'user-data-type') {
    return { derived: { name: type.value } }
  }
  return iecBase({ definition: 'base-type', value: type.value })
}

const iecBase = (base: { definition: 'base-type' | 'user-data-type'; value: string }): Record<string, unknown> => {
  if (base.definition === 'user-data-type') return { derived: { name: base.value } }
  const key = base.value === 'string' ? 'string' : base.value.toUpperCase()
  return { [key]: '' }
}

const iecTypeToEditor = (typeNode: unknown): PLCVariable['type'] | null => {
  if (!isRecord(typeNode)) return null
  if (isRecord(typeNode.array)) {
    const array = typeNode.array
    const dimensions = asArray(array.dimension as Record<string, unknown> | Record<string, unknown>[]).map((dimension) => {
      const lower = attr(dimension, 'lower')
      const upper = attr(dimension, 'upper')
      return { dimension: `${lower}..${upper}` }
    })
    const base = iecTypeToEditor(array.baseType)
    if (!base || (base.definition !== 'base-type' && base.definition !== 'user-data-type' && base.definition !== 'derived')) {
      return null
    }
    const baseType =
      base.definition === 'derived' || base.definition === 'user-data-type'
        ? { definition: 'user-data-type' as const, value: base.value }
        : { definition: 'base-type' as const, value: base.value }
    return {
      definition: 'array',
      value: baseType.value,
      data: { baseType, dimensions },
    }
  }
  if (isRecord(typeNode.derived)) {
    return { definition: 'derived', value: attr(typeNode.derived, 'name') }
  }
  for (const [key, value] of Object.entries(typeNode)) {
    if (key.startsWith('@') || key === '#') continue
    if (key === 'array' || key === 'derived' || key === 'enum' || key === 'struct') continue
    if (isRecord(value) && attr(value, 'name')) {
      return { definition: 'derived', value: attr(value, 'name') }
    }
    const lower = key.toLowerCase()
    if (BASE_TYPES.has(lower)) {
      return { definition: 'base-type', value: lower as BaseTypeName }
    }
  }
  return null
}

const variableToIec = (variable: PLCVariable): IecVariable => {
  const iec: IecVariable = {
    name: variable.name,
    type: editorTypeToIec(variable.type),
    documentation: { 'xhtml:p': variable.documentation === '' ? ' ' : variable.documentation },
    debug: variable.debug,
  }
  if (variable.location) iec.address = variable.location
  if (variable.initialValue) iec.initialValue = { simpleValue: { value: variable.initialValue } }
  return iec
}

const variableFromIec = (
  node: unknown,
  variableClass: PLCVariable['class'],
  debugMap: Record<string, boolean>,
): PLCVariable | null => {
  if (!isRecord(node)) return null
  const name = attr(node, 'name')
  if (!name) return null
  const type = iecTypeToEditor(node.type)
  if (!type) return null
  let initialValue: string | null | undefined
  if (isRecord(node.initialValue) && isRecord(node.initialValue.simpleValue)) {
    initialValue = attr(node.initialValue.simpleValue, 'value')
  }
  const documentation = textOf(node.documentation)
  const variable: PLCVariable = {
    name,
    class: variableClass,
    type,
    location: attr(node, 'address'),
    documentation: documentation === ' ' ? '' : documentation,
    debug: debugMap[name] === true || node.debug === true,
  }
  if (initialValue) variable.initialValue = initialValue
  return variable
}

const CLASS_GROUPS: Array<[PLCVariable['class'], string]> = [
  ['input', 'inputVars'],
  ['output', 'outputVars'],
  ['inOut', 'inOutVars'],
  ['external', 'externalVars'],
  ['local', 'localVars'],
  ['temp', 'tempVars'],
  ['global', 'globalVars'],
]

const pouToProjection = (pou: PLCPou): { pou: IecPou; warnings: string[] } => {
  const warnings: string[] = []
  const interfaceNode: Record<string, unknown> = {}
  const debug: Record<string, boolean> = {}
  if (pou.type === 'function') {
    const returnType = pou.data.returnType
    const lower = returnType.toLowerCase()
    interfaceNode.returnType = BASE_TYPES.has(lower)
      ? { [lower === 'string' ? 'string' : returnType.toUpperCase()]: '' }
      : { derived: { name: returnType } }
  }
  for (const variable of pou.data.variables) {
    const group = CLASS_GROUPS.find(([variableClass]) => variableClass === (variable.class ?? 'local'))
    const key = group?.[1] ?? 'localVars'
    const bucket = (interfaceNode[key] as { variable: IecVariable[] } | undefined) ?? { variable: [] }
    bucket.variable.push(variableToIec(variable))
    interfaceNode[key] = bucket
    if (variable.debug) debug[variable.name] = true
  }

  const body: Record<string, unknown> = {}
  const addData: IecPou['addData'] = { openplc: {} }
  const language = pou.data.body.language
  if (language === 'st' || language === 'il') {
    const source = pou.data.body.value
    body[language.toUpperCase()] = { 'xhtml:p': source }
    if (/\/\/|\/\*/.test(source)) {
      warnings.push(`POU "${pou.data.name}" 的 ${language.toUpperCase()} 注释会在导出时改写成 (* *)，以迁就 MatIEC。`)
    }
  } else if (language === 'ld' || language === 'fbd') {
    body[language.toUpperCase()] = {}
    addData.openplc = { ...addData.openplc, graph: pou.data.body.value }
    warnings.push(
      `POU "${pou.data.name}" 的 ${language.toUpperCase()} 以 addData/openplc/graph 还原界面。标准 body 仍由 XmlGenerator 交给 xml2st；视口和 parallel 不能从标准图形还原。`,
    )
  } else if (language === 'sfc') {
    body.SFC = { 'xhtml:p': pou.data.body.value }
    warnings.push(`POU "${pou.data.name}" 是 SFC，当前不会写入 plc.xml。`)
  } else if (language === 'python') {
    addData.openplc = { ...addData.openplc, language: 'python', source: pou.data.body.value }
    warnings.push(`POU "${pou.data.name}" 是 Python，标准中没有该语言，将在编译前改写成 ST。`)
  }
  if (Object.keys(debug).length > 0) addData.openplc = { ...addData.openplc, debug }

  return {
    pou: {
      name: pou.data.name,
      pouType: pou.type === 'function-block' ? 'functionBlock' : pou.type,
      interface: interfaceNode,
      body,
      documentation: { 'xhtml:p': pou.data.documentation === '' ? ' ' : pou.data.documentation },
      addData,
    },
    warnings,
  }
}

const returnTypeFromIec = (node: unknown): string | null => {
  if (!isRecord(node)) return null
  if (isRecord(node.derived)) return attr(node.derived, 'name') || null
  for (const key of Object.keys(node)) {
    if (key.startsWith('@')) continue
    const lower = key.toLowerCase()
    if (BASE_TYPES.has(lower)) return lower
  }
  return null
}

const graphFromPou = (pou: IecPou): unknown => pou.addData?.openplc?.graph

const projectionToPou = (input: unknown): { pou: PLCPou; warnings: string[] } | ToolFailure => {
  if (!isRecord(input)) return fail('validation', 'pou must be an object')
  const name = attr(input, 'name')
  const pouTypeRaw = attr(input, 'pouType')
  if (!name) return fail('validation', 'pou.name is required')
  if (pouTypeRaw !== 'program' && pouTypeRaw !== 'function' && pouTypeRaw !== 'functionBlock') {
    return fail('validation', 'pou.pouType must be program, function, or functionBlock')
  }
  const warnings: string[] = []
  const interfaceNode = isRecord(input.interface) ? input.interface : {}
  const debugMap = isRecord(input.addData) && isRecord(input.addData.openplc) && isRecord(input.addData.openplc.debug)
    ? (input.addData.openplc.debug as Record<string, boolean>)
    : {}
  const variables: PLCVariable[] = []
  for (const [variableClass, key] of CLASS_GROUPS) {
    const group = interfaceNode[key]
    if (!isRecord(group)) continue
    for (const variableNode of asArray(group.variable)) {
      const variable = variableFromIec(variableNode, variableClass, debugMap)
      if (!variable) {
        warnings.push(`POU "${name}" 跳过了无法识别的变量。`)
        continue
      }
      if (variableClass === 'global') {
        warnings.push(`POU "${name}" 的变量 "${variable.name}" 使用 class global，写入 interface/globalVars。`)
      }
      variables.push(variable)
    }
  }

  const bodyNode = isRecord(input.body) ? input.body : {}
  const openplc = isRecord(input.addData) && isRecord(input.addData.openplc) ? input.addData.openplc : {}
  const iecPou = input as unknown as IecPou
  let language: PLCPou['data']['language']
  let value: PLCPou['data']['body']['value']

  if ('SFC' in bodyNode && !('ST' in bodyNode) && !('IL' in bodyNode)) {
    return fail('validation', `POU "${name}" body.SFC is not accepted. This editor has no SFC graphic model, and pou-xml would drop it from plc.xml.`)
  }
  if (openplc.language === 'python' || typeof openplc.source === 'string') {
    language = 'python'
    value = typeof openplc.source === 'string' ? openplc.source : ''
    warnings.push(`POU "${name}" 是 Python，将在编译前改写成 ST，不会原样进入 plc.xml。`)
  } else if ('ST' in bodyNode) {
    language = 'st'
    value = textOf(bodyNode.ST)
  } else if ('IL' in bodyNode) {
    language = 'il'
    value = textOf(bodyNode.IL)
  } else if ('LD' in bodyNode) {
    language = 'ld'
    const graph = graphFromPou(iecPou)
    if (isRecord(graph) && Array.isArray(graph.rungs)) {
      value = graph as Extract<PLCPou['data']['body'], { language: 'ld' }>['value']
    } else {
      value = { name, rungs: [] }
      warnings.push(`POU "${name}" 的 LD 没有 addData/openplc/graph，界面图形未还原。`)
    }
    if (!isRecord(bodyNode.LD)) warnings.push(`POU "${name}" 的标准 body/LD 未能校验。`)
  } else if ('FBD' in bodyNode) {
    language = 'fbd'
    const graph = graphFromPou(iecPou)
    if (isRecord(graph) && isRecord(graph.rung)) {
      value = graph as Extract<PLCPou['data']['body'], { language: 'fbd' }>['value']
    } else {
      value = { name, rung: { comment: '', edges: [], nodes: [] } }
      warnings.push(`POU "${name}" 的 FBD 没有 addData/openplc/graph，界面图形未还原。`)
    }
    if (!isRecord(bodyNode.FBD)) warnings.push(`POU "${name}" 的标准 body/FBD 未能校验。`)
  } else {
    return fail('validation', `POU "${name}" needs a body of ST, IL, LD, or FBD, or addData.openplc language python.`)
  }

  const documentation = textOf(input.documentation)
  const pouType = pouTypeRaw === 'functionBlock' ? 'function-block' : pouTypeRaw
  const data = {
    name,
    language,
    variables,
    documentation: documentation === ' ' ? '' : documentation,
    body: { language, value },
    ...(pouType === 'function' ? { returnType: returnTypeFromIec(interfaceNode.returnType) ?? '' } : {}),
  }
  if (pouType === 'function' && !('returnType' in data && data.returnType)) {
    return fail('validation', `Function "${name}" is missing interface.returnType.`)
  }
  const parsed = PLCPouSchema.safeParse({ type: pouType, data })
  if (!parsed.success) return fail('validation', parsed.error.issues.map((issue) => issue.message).join('; '))
  return { pou: parsed.data, warnings }
}

const dataTypeToIec = (dataType: PLCDataType): Record<string, unknown> => {
  if (dataType.derivation === 'enumerated') {
    return {
      name: dataType.name,
      baseType: { enum: { values: { value: dataType.values.map((value) => ({ name: value.description })) } } },
      ...(dataType.initialValue ? { initialValue: { simpleValue: { value: dataType.initialValue } } } : {}),
    }
  }
  if (dataType.derivation === 'array') {
    return {
      name: dataType.name,
      baseType: {
        array: {
          dimension: dataType.dimensions.map((dimension) => {
            const [lower, upper] = dimension.dimension.split('..')
            return { lower: lower ?? '', upper: upper ?? '' }
          }),
          baseType: iecBase(dataType.baseType),
        },
      },
      ...(dataType.initialValue ? { initialValue: { simpleValue: { value: dataType.initialValue } } } : {}),
    }
  }
  return {
    name: dataType.name,
    baseType: {
      struct: {
        variable: dataType.variable.map((variable) => ({
          name: variable.name,
          type: editorTypeToIec(variable.type),
          ...(variable.initialValue ? { initialValue: { simpleValue: { value: variable.initialValue.simpleValue.value } } } : {}),
        })),
      },
    },
  }
}

const initialValueOf = (node: unknown): string | undefined => {
  if (!isRecord(node) || !isRecord(node.initialValue) || !isRecord(node.initialValue.simpleValue)) return undefined
  const value = attr(node.initialValue.simpleValue, 'value')
  return value || undefined
}

const dataTypeFromIec = (node: unknown): PLCDataType | null => {
  if (!isRecord(node)) return null
  const name = attr(node, 'name')
  if (!name || !isRecord(node.baseType)) return null
  const baseType = node.baseType
  const initialValue = initialValueOf(node)
  if (isRecord(baseType.enum)) {
    const values = asArray(
      isRecord(baseType.enum.values) ? (baseType.enum.values.value) : undefined,
    ).map((value) => ({ description: isRecord(value) ? attr(value, 'name') : String(value) }))
    const parsed = PLCDataTypeSchema.safeParse({ name, derivation: 'enumerated', values, initialValue })
    return parsed.success ? parsed.data : null
  }
  if (isRecord(baseType.array)) {
    const inner = iecTypeToEditor(baseType.array.baseType)
    if (!inner || (inner.definition !== 'base-type' && inner.definition !== 'derived' && inner.definition !== 'user-data-type')) {
      return null
    }
    const dimensions = asArray(baseType.array.dimension as Record<string, unknown> | Record<string, unknown>[]).map(
      (dimension) => ({ dimension: `${attr(dimension, 'lower')}..${attr(dimension, 'upper')}` }),
    )
    const parsed = PLCDataTypeSchema.safeParse({
      name,
      derivation: 'array',
      baseType:
        inner.definition === 'base-type'
          ? { definition: 'base-type', value: inner.value }
          : { definition: 'user-data-type', value: inner.value },
      dimensions,
      initialValue,
    })
    return parsed.success ? parsed.data : null
  }
  if (isRecord(baseType.struct)) {
    const variable = asArray(baseType.struct.variable).flatMap((item) => {
      if (!isRecord(item)) return []
      const type = iecTypeToEditor(item.type)
      if (!type) return []
      const fieldInitial = initialValueOf(item)
      return [
        {
          name: attr(item, 'name'),
          type,
          ...(fieldInitial ? { initialValue: { simpleValue: { value: fieldInitial } } } : {}),
        },
      ]
    })
    const parsed = PLCDataTypeSchema.safeParse({ name, derivation: 'structure', variable })
    return parsed.success ? parsed.data : null
  }
  return null
}

const resourceToProjection = (configuration: PLCConfiguration): IecResource => {
  const warnings: string[] = []
  const { tasks, instances, globalVariables } = configuration.resource
  return {
    tasks: tasks.map((task) => {
      const pouInstance = instances
        .filter((instance) => instance.task === task.name)
        .map((instance) => ({ name: instance.name, typeName: instance.program, task: task.name }))
      const projected: Record<string, unknown> = {
        name: task.name,
        priority: String(task.priority),
        pouInstance,
      }
      if (task.triggering === 'Interrupt') projected.single = ''
      else projected.interval = task.interval
      return projected
    }),
    pouInstances: instances.map((instance) => ({
      name: instance.name,
      typeName: instance.program,
      task: instance.task,
    })),
    globalVars: globalVariables.map((variable) => variableToIec({ ...variable, class: undefined, debug: variable.debug })),
    warnings,
  }
}

const resourceFromProjection = (input: {
  tasks?: unknown
  pouInstances?: unknown
  globalVars?: unknown
}): { configuration: PLCConfiguration; warnings: string[] } | ToolFailure => {
  const warnings: string[] = []
  const tasks: PLCTask[] = []
  const instances: PLCInstance[] = []
  for (const taskNode of asArray(input.tasks)) {
    if (!isRecord(taskNode)) continue
    const name = attr(taskNode, 'name')
    if (!name) continue
    const single = taskNode['@single'] ?? taskNode.single
    const interval = taskNode['@interval'] ?? taskNode.interval
    const triggering = single !== undefined && single !== null && (interval === undefined || interval === null) ? 'Interrupt' : 'Cyclic'
    tasks.push({
      name,
      triggering,
      interval: triggering === 'Cyclic' && (typeof interval === 'string' || typeof interval === 'number') ? String(interval) : '',
      priority: Number(attr(taskNode, 'priority') || '0'),
    })
    for (const pouInstance of asArray(taskNode.pouInstance)) {
      if (!isRecord(pouInstance)) continue
      instances.push({
        name: attr(pouInstance, 'name'),
        program: attr(pouInstance, 'typeName'),
        task: attr(pouInstance, 'task') || name,
      })
    }
  }
  for (const pouInstance of asArray(input.pouInstances)) {
    if (!isRecord(pouInstance)) continue
    const instanceName = attr(pouInstance, 'name')
    if (instances.some((instance) => instance.name === instanceName)) continue
    instances.push({
      name: instanceName,
      program: attr(pouInstance, 'typeName') || attr(pouInstance, 'program'),
      task: attr(pouInstance, 'task'),
    })
  }
  const globalVariables = asArray(input.globalVars).flatMap((node) => {
    const variable = variableFromIec(node, undefined, {})
    if (!variable) {
      warnings.push('跳过了无法识别的资源全局变量。')
      return []
    }
    const { class: _class, ...globalVariable } = variable
    return [globalVariable]
  })
  const parsed = {
    resource: { tasks, instances, globalVariables },
  }
  return { configuration: parsed as PLCConfiguration, warnings }
}

const projectWarnings = (bundle: ProjectBundle): string[] =>
  bundle.pous.flatMap((pou) => pouToProjection(pou).warnings)

const readOpenPlcPayload = (project: Record<string, unknown>): Record<string, unknown> | null => {
  const addData = project.addData
  if (!isRecord(addData)) return null
  const entries = asArray(addData.data)
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    if (attr(entry, 'name') && attr(entry, 'name') !== OPENPLC_DATA_NAME) continue
    if (isRecord(entry.openplc)) return entry.openplc
  }
  return null
}

const jsonText = (node: unknown): unknown => {
  const text = textOf(node)
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const injectOpenPlcAddData = (xml: string, bundle: ProjectBundle): string => {
  const graphs: Record<string, unknown> = {}
  const python: PLCPou[] = []
  const debug: Record<string, Record<string, boolean>> = {}
  for (const pou of bundle.pous) {
    if (pou.data.body.language === 'ld' || pou.data.body.language === 'fbd') {
      graphs[pou.data.name] = pou.data.body.value
    }
    if (pou.data.body.language === 'python') python.push(pou)
    const flags: Record<string, boolean> = {}
    for (const variable of pou.data.variables) {
      if (variable.debug) flags[variable.name] = true
    }
    if (Object.keys(flags).length > 0) debug[pou.data.name] = flags
  }
  const doc = create(xml)
  const openplc = doc
    .root()
    .ele('addData')
    .ele('data', { name: OPENPLC_DATA_NAME, handleUnknown: 'implementation' })
    .ele('openplc')
  openplc.ele('meta').att('type', bundle.project.meta.type)
  openplc.ele('device').txt(JSON.stringify(bundle.deviceConfiguration))
  openplc.ele('pins').txt(JSON.stringify(bundle.devicePinMapping))
  openplc.ele('graph').txt(JSON.stringify(graphs))
  openplc.ele('python').txt(JSON.stringify(python))
  openplc.ele('debug').txt(JSON.stringify(debug))
  return doc.end({ prettyPrint: true })
}

const exportProjectXml = (
  bundle: ProjectBundle,
  dialect: 'old-editor' | 'codesys' = 'old-editor',
): { ok: true; xml: string; warnings: string[] } | ToolFailure => {
  const generated = XmlGenerator(bundleToCompileData(bundle), dialect, { projectName: bundle.project.meta.name })
  if (!generated.ok || !generated.data) {
    return fail('main-pou-missing', generated.message || 'Main POU not found.')
  }
  const warnings = projectWarnings(bundle)
  if (dialect === 'codesys') {
    warnings.push('codesys 方言不会被编译使用。编译固定调用 old-editor。')
  }
  const xml = dialect === 'old-editor' ? injectOpenPlcAddData(generated.data, bundle) : generated.data
  return { ok: true, xml, warnings }
}

const pousFromXml = (
  types: Record<string, unknown>,
  graphs: Record<string, unknown>,
  pythonPous: PLCPou[],
  debug: Record<string, Record<string, boolean>>,
): { pous: PLCPou[]; warnings: string[] } | ToolFailure => {
  const warnings: string[] = []
  const pous: PLCPou[] = []
  const pouNodes = isRecord(types.pous) ? asArray(types.pous.pou) : []
  for (const pouNode of pouNodes) {
    if (!isRecord(pouNode)) continue
    const name = attr(pouNode, 'name')
    const graph = graphs[name]
    const withGraph = {
      ...pouNode,
      addData: {
        openplc: {
          ...(graph ? { graph } : {}),
          ...(debug[name] ? { debug: debug[name] } : {}),
        },
      },
    }
    if (isRecord(pouNode.body) && 'SFC' in pouNode.body) {
      warnings.push(`POU "${name}" 是 SFC，未写入工程。当前没有 SFC 图形模型，pou-xml 也不会把它写入 plc.xml。`)
      continue
    }
    const converted = projectionToPou(withGraph)
    if (isFailure(converted)) {
      warnings.push(converted.error.message)
      continue
    }
    warnings.push(...converted.warnings)
    pous.push(converted.pou)
  }
  for (const pythonPou of pythonPous) {
    if (pous.some((pou) => pou.data.name === pythonPou.data.name)) continue
    const parsed = PLCPouSchema.safeParse(pythonPou)
    if (!parsed.success) {
      warnings.push(`Python POU 未能还原：${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
      continue
    }
    warnings.push(`POU "${parsed.data.data.name}" 是 Python，将在编译前改写成 ST。`)
    pous.push(parsed.data)
  }
  return { pous, warnings }
}

const applyProjectXml = (
  bundle: ProjectBundle,
  xml: string,
  mode: 'replace' | 'merge',
): { bundle: ProjectBundle; warnings: string[] } | ToolFailure => {
  let document: unknown
  try {
    document = create(xml).end({ format: 'object' })
  } catch (error) {
    return fail('validation', error instanceof Error ? error.message : 'Invalid XML')
  }
  if (!isRecord(document) || !isRecord(document.project)) return fail('validation', 'XML has no project element')
  const project = document.project
  const warnings: string[] = []
  const name = isRecord(project.contentHeader) ? attr(project.contentHeader, 'name') : ''
  const nextProject = {
    ...bundle.project,
    meta: { ...bundle.project.meta },
    data: { ...bundle.project.data },
  }
  if (name && name !== 'Unnamed') nextProject.meta.name = name

  const openplc = readOpenPlcPayload(project)
  if (openplc && isRecord(openplc.meta)) {
    const projectType = attr(openplc.meta, 'type')
    if (projectType === 'plc-project' || projectType === 'plc-library') nextProject.meta.type = projectType
  }

  let deviceConfiguration = bundle.deviceConfiguration
  let devicePinMapping = bundle.devicePinMapping
  if (openplc) {
    const device = jsonText(openplc.device)
    const deviceParsed = deviceConfigurationSchema.safeParse(device)
    if (deviceParsed.success) deviceConfiguration = deviceParsed.data
    else if (device !== undefined) warnings.push('addData/openplc/device 未能通过设备 schema，保留原 devices/configuration.json。')
    const pins = jsonText(openplc.pins)
    const pinsParsed = devicePinSchema.array().safeParse(pins)
    if (pinsParsed.success) devicePinMapping = pinsParsed.data
    else if (pins !== undefined) warnings.push('addData/openplc/pins 未能通过引脚 schema，保留原 pin-mapping.json。')
  }

  const graphs = (openplc ? jsonText(openplc.graph) : undefined) as Record<string, unknown> | undefined
  const pythonRaw = openplc ? jsonText(openplc.python) : undefined
  const pythonPous = Array.isArray(pythonRaw) ? (pythonRaw as PLCPou[]) : []
  const debug = (openplc && isRecord(jsonText(openplc.debug)) ? jsonText(openplc.debug) : {}) as Record<
    string,
    Record<string, boolean>
  >

  const types = isRecord(project.types) ? project.types : {}
  const dataTypeNodes = isRecord(types.dataTypes) ? asArray(types.dataTypes.dataType) : []
  const parsedTypes: PLCDataType[] = []
  for (const dataTypeNode of dataTypeNodes) {
    const dataType = dataTypeFromIec(dataTypeNode)
    if (!dataType) warnings.push('跳过了无法识别的 dataType。')
    else parsedTypes.push(dataType)
  }

  const convertedPous = pousFromXml(types, graphs ?? {}, pythonPous, debug ?? {})
  if (isFailure(convertedPous)) return convertedPous
  warnings.push(...convertedPous.warnings)

  const instances = isRecord(project.instances) ? project.instances : {}
  const configurations = isRecord(instances.configurations)
    ? asArray(instances.configurations.configuration)
    : []
  if (configurations.length > 1) warnings.push('标准允许多个 configuration。本编辑器只有一个，已使用第一个。')
  const configurationNode = configurations[0]
  let nextConfiguration = bundle.project.data.configuration
  if (isRecord(configurationNode)) {
    const configurationName = attr(configurationNode, 'name')
    if (configurationName && configurationName !== 'Config0') {
      warnings.push(`configuration 名称 "${configurationName}" 已忽略，仍写入唯一的 Config0。`)
    }
    const resources = asArray(configurationNode.resource)
    if (resources.length > 1) warnings.push('标准允许多个 resource。本编辑器只有 Res0，已使用第一个。')
    const resourceNode = resources[0]
    if (isRecord(resourceNode)) {
      const resourceName = attr(resourceNode, 'name')
      if (resourceName && resourceName !== 'Res0') {
        warnings.push(`resource 名称 "${resourceName}" 已忽略，仍写入唯一的 Res0。`)
      }
      const resource = resourceFromProjection({
        tasks: resourceNode.task,
        globalVars: isRecord(resourceNode.globalVars) ? resourceNode.globalVars.variable : [],
      })
      if (isFailure(resource)) return resource
      warnings.push(...resource.warnings)
      nextConfiguration = resource.configuration
    }
  }

  let pous = convertedPous.pous
  let dataTypes = parsedTypes
  if (mode === 'merge') {
    const byName = new Map(bundle.pous.map((pou) => [pou.data.name, pou]))
    for (const pou of convertedPous.pous) byName.set(pou.data.name, pou)
    pous = [...byName.values()]
    const typesByName = new Map(bundle.project.data.dataTypes.map((dataType) => [dataType.name, dataType]))
    for (const dataType of parsedTypes) typesByName.set(dataType.name, dataType)
    dataTypes = [...typesByName.values()]
  }

  if (!pous.some((pou) => pou.type === 'program' && pou.data.name === 'main')) {
    return fail('main-pou-missing', 'Main POU not found.')
  }

  nextProject.data = {
    ...nextProject.data,
    dataTypes,
    pous,
    configuration: nextConfiguration,
  }
  return {
    bundle: {
      path: bundle.path,
      project: nextProject,
      pous,
      deviceConfiguration,
      devicePinMapping,
    },
    warnings,
  }
}

const addressesChanged = (before: ProjectBundle, after: ProjectBundle): boolean => {
  const locationKey = (pous: PLCPou[]) =>
    pous
      .map((pou) => `${pou.data.name}:${pou.data.variables.map((variable) => `${variable.name}=${variable.location}`).join(',')}`)
      .sort()
      .join('|')
  const globalKey = (bundle: ProjectBundle) =>
    bundle.project.data.configuration.resource.globalVariables
      .map((variable) => `${variable.name}=${variable.location}`)
      .join('|')
  return locationKey(before.pous) !== locationKey(after.pous) || globalKey(before) !== globalKey(after)
}

const deviceChanged = (before: DeviceConfiguration, after: DeviceConfiguration): boolean =>
  JSON.stringify(before) !== JSON.stringify(after)

const pinsChanged = (before: DevicePin[], after: DevicePin[]): boolean => JSON.stringify(before) !== JSON.stringify(after)

export {
  addressesChanged,
  applyProjectXml,
  dataTypeFromIec,
  dataTypeToIec,
  deviceChanged,
  exportProjectXml,
  pinsChanged,
  pouToProjection,
  projectionToPou,
  resourceFromProjection,
  resourceToProjection,
}
export type { IecPou, IecResource, IecVariable }
