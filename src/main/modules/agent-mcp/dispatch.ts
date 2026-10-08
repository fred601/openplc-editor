import { z } from 'zod'

import { AgentContext } from './context'
import { exportProjectXml } from './iec-map'
import { compileStart, downloadStart, hardwareBoards, hardwarePorts, jobGet } from './tools/compile'
import { debugCompile, debugConnect, debugDisconnect, debugReadVariables, debugVerifyMd5 } from './tools/debug'
import {
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
} from './tools/program'
import { projectCreate, projectListRecent, projectOpen, projectSave } from './tools/project-create'
import { runtimeLogin, runtimeStart, runtimeStatus, runtimeStop, runtimeUsers } from './tools/runtime'
import { fail, isFailure } from './types'

type ToolHandler = (ctx: AgentContext, input: unknown) => unknown

const tools: Record<string, { description: string; inputSchema: Record<string, unknown>; handler: ToolHandler }> = {
  session_info: {
    description: 'Editor version, open project path, write lock, and the active job id.',
    inputSchema: { type: 'object', properties: {} },
    handler: (ctx) => ({ ok: true, ...ctx.session.info(ctx.deps.version) }),
  },
  session_set_mode: {
    description: 'Set supervised (default) or autonomous mode. Does not release the write lock.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['supervised', 'autonomous'] } },
      required: ['mode'],
    },
    handler: (ctx, input) => {
      const parsed = z.object({ mode: z.enum(['supervised', 'autonomous']) }).safeParse(input)
      if (!parsed.success) return fail('validation', 'mode must be supervised or autonomous')
      const result = ctx.session.setMode(parsed.data.mode)
      ctx.publishLock()
      return result
    },
  },
  session_release: {
    description: 'Release the project write lock. session_set_mode does not do this.',
    inputSchema: { type: 'object', properties: {} },
    handler: (ctx) => {
      const result = ctx.session.release()
      ctx.publishLock()
      return result
    },
  },
  project_create: {
    description: 'Create a project directory, project.json, device files, and pous/programs/main.json.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        path: { type: 'string' },
        language: { type: 'string', enum: ['il', 'st', 'ld', 'sfc', 'fbd'] },
        type: { type: 'string', enum: ['plc-project', 'plc-library'] },
        time: { type: 'string' },
      },
      required: ['name', 'path', 'language', 'type', 'time'],
    },
    handler: projectCreate,
  },
  project_open: {
    description: 'Open a project directory that contains project.json. Does not show a file dialog.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: projectOpen,
  },
  project_save: {
    description: 'Save the open project. Prefers the editor snapshot, then the session copy. Refused while a job is running.',
    inputSchema: { type: 'object', properties: {} },
    handler: (ctx) => projectSave(ctx),
  },
  project_list_recent: {
    description: 'Recent projects from User/History/projects.json.',
    inputSchema: { type: 'object', properties: {} },
    handler: projectListRecent,
  },
  program_export_xml: {
    description: 'Export the open project as IEC 61131-10 XML. Default dialect is old-editor (tc6_0201). Does not open a save dialog.',
    inputSchema: {
      type: 'object',
      properties: { dialect: { type: 'string', enum: ['old-editor', 'codesys'] } },
    },
    handler: programExportXml,
  },
  program_apply_xml: {
    description: 'Apply an IEC 61131-10 document onto the open project and save it.',
    inputSchema: {
      type: 'object',
      properties: { xml: { type: 'string' }, mode: { type: 'string', enum: ['replace', 'merge'] } },
      required: ['xml', 'mode'],
    },
    handler: programApplyXml,
  },
  pou_list: {
    description: 'List POUs in the open project.',
    inputSchema: { type: 'object', properties: {} },
    handler: pouList,
  },
  pou_get: {
    description: 'Return one POU as an IEC 61131-10 JSON projection.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: pouGet,
  },
  pou_upsert: {
    description: 'Create or replace one POU from an IEC 61131-10 JSON projection.',
    inputSchema: { type: 'object' },
    handler: pouUpsert,
  },
  pou_delete: {
    description: 'Delete a POU. The program named main cannot be deleted.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: pouDelete,
  },
  datatype_upsert: {
    description: 'Create or replace one dataType element.',
    inputSchema: { type: 'object' },
    handler: datatypeUpsert,
  },
  datatype_delete: {
    description: 'Delete a data type by name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    handler: datatypeDelete,
  },
  resource_get: {
    description: 'Return the single configuration resource: tasks, pou instances, and global variables.',
    inputSchema: { type: 'object', properties: {} },
    handler: resourceGet,
  },
  resource_apply: {
    description: 'Replace tasks, pou instances, and resource global variables.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array' },
        pouInstances: { type: 'array' },
        globalVars: { type: 'array' },
      },
    },
    handler: resourceApply,
  },
  compile_start: {
    description:
      'Compile the open project with compileOnly=true and return a jobId. OpenPLC Runtime targets stop after source generation. Arduino targets still run arduino-cli and do not upload.',
    inputSchema: {
      type: 'object',
      properties: { boardTarget: { type: 'string' }, compileOnly: { type: 'boolean' } },
      required: ['boardTarget'],
    },
    handler: compileStart,
  },
  download_start: {
    description: 'Compile and upload (compileOnly=false). Supervised mode asks for confirmation. Returns a jobId immediately.',
    inputSchema: { type: 'object', properties: { boardTarget: { type: 'string' } }, required: ['boardTarget'] },
    handler: downloadStart,
  },
  job_get: {
    description: 'Read job status and compiler logs. levels are info, warning, and error.',
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
    handler: jobGet,
  },
  hardware_boards: {
    description: 'Board names with core, the hals.json compiler field, pins, and specs.',
    inputSchema: { type: 'object', properties: {} },
    handler: hardwareBoards,
  },
  hardware_ports: {
    description: 'Serial port names from the hardware module.',
    inputSchema: { type: 'object', properties: {} },
    handler: hardwarePorts,
  },
  runtime_login: {
    description: 'POST /api/login on the OpenPLC Runtime and store the JWT on the device slice.',
    inputSchema: {
      type: 'object',
      properties: { ipAddress: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' } },
      required: ['ipAddress', 'username', 'password'],
    },
    handler: runtimeLogin,
  },
  runtime_status: {
    description: 'GET /api/status.',
    inputSchema: {
      type: 'object',
      properties: { ipAddress: { type: 'string' }, accessToken: { type: 'string' } },
      required: ['ipAddress', 'accessToken'],
    },
    handler: runtimeStatus,
  },
  runtime_start: {
    description: 'GET /api/start-plc. Supervised mode asks for confirmation. There is no tool to create runtime users.',
    inputSchema: {
      type: 'object',
      properties: { ipAddress: { type: 'string' }, accessToken: { type: 'string' } },
      required: ['ipAddress', 'accessToken'],
    },
    handler: runtimeStart,
  },
  runtime_stop: {
    description: 'GET /api/stop-plc. Supervised mode asks for confirmation.',
    inputSchema: {
      type: 'object',
      properties: { ipAddress: { type: 'string' }, accessToken: { type: 'string' } },
      required: ['ipAddress', 'accessToken'],
    },
    handler: runtimeStop,
  },
  runtime_users: {
    description: 'GET /api/get-users-info. Reports whether users exist. Does not create users.',
    inputSchema: { type: 'object', properties: { ipAddress: { type: 'string' } }, required: ['ipAddress'] },
    handler: runtimeUsers,
  },
  debug_compile: {
    description: 'Run compileForDebugger. job_get then includes variables parsed from VARIABLES.csv.',
    inputSchema: { type: 'object', properties: { boardTarget: { type: 'string' } }, required: ['boardTarget'] },
    handler: debugCompile,
  },
  debug_connect: {
    description: 'Connect the single Modbus debugger client. TCP uses port 502. Supervised mode asks for confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionType: { type: 'string', enum: ['tcp', 'rtu'] },
        ipAddress: { type: 'string' },
        port: { type: 'string' },
        baudRate: { type: 'number' },
        slaveId: { type: 'number' },
      },
      required: ['connectionType'],
    },
    handler: debugConnect,
  },
  debug_verify_md5: {
    description: 'Compare expectedMd5 with DEBUG_GET_MD5 (0x45) on the connected debugger.',
    inputSchema: { type: 'object', properties: { expectedMd5: { type: 'string' } }, required: ['expectedMd5'] },
    handler: debugVerifyMd5,
  },
  debug_read_variables: {
    description: 'Read variables by index with DEBUG_GET_LIST (0x44). Indexes come from VARIABLES.csv. Writing variables (0x42) is not implemented.',
    inputSchema: { type: 'object', properties: { indexes: { type: 'array', items: { type: 'number' } } }, required: ['indexes'] },
    handler: debugReadVariables,
  },
  debug_disconnect: {
    description: 'Disconnect the debugger client.',
    inputSchema: { type: 'object', properties: {} },
    handler: debugDisconnect,
  },
}

const prompts = [
  {
    name: 'edit-via-iec-xml',
    description: 'Edit a program through IEC 61131-10 XML, then check the project.',
    text: 'Call program_export_xml, change standard elements, call program_apply_xml, then project_open to check the files. Keep OpenPLC-only data under addData/openplc.',
  },
  {
    name: 'compile-and-report',
    description: 'Compile and report compiler logs without changing compiler binaries.',
    text: 'Call compile_start, then poll job_get. Give error logs to the user. Do not modify compiler binaries.',
  },
]

const callTool = async (ctx: AgentContext, name: string, args: unknown) => {
  const tool = tools[name]
  if (!tool) return fail('not-found', `Unknown tool ${name}`)
  return await Promise.resolve(tool.handler(ctx, args ?? {}))
}

const readResource = async (ctx: AgentContext, uri: string) => {
  if (uri === 'openplc://session') return { uri, mimeType: 'application/json', text: JSON.stringify(ctx.session.info(ctx.deps.version)) }
  if (uri === 'openplc://project/xml') {
    const project = ctx.requireProject()
    if (isFailure(project)) return fail('no-project', project.error.message)
    const xml = exportProjectXml(project, 'old-editor')
    if (isFailure(xml)) return xml
    return { uri, mimeType: 'application/xml', text: xml.xml }
  }
  if (uri === 'openplc://hardware/boards') {
    const boards = await hardwareBoards(ctx)
    return { uri, mimeType: 'application/json', text: JSON.stringify(boards) }
  }
  const jobMatch = /^openplc:\/\/jobs\/([^/]+)$/.exec(uri)
  if (jobMatch?.[1]) {
    const job = jobGet(ctx, { jobId: decodeURIComponent(jobMatch[1]) })
    return { uri, mimeType: 'application/json', text: JSON.stringify(job) }
  }
  return fail('not-found', `Unknown resource ${uri}`)
}

export { callTool, prompts, readResource, tools }
