# Agent MCP 开发说明

本机编辑器进程里的 MCP 服务。磁盘上的工程仍是 JSON。Agent 看到的是 IEC 61131-10 XML 或与之对应的 JSON 投影。不绑定 `0.0.0.0`，不把 bearer token 写进仓库或日志。

## 怎么跑编辑器

依赖安装用带脚本的 `npm ci`（会下载 Electron）。开发启动：

```bash
npm run start:dev
```

主进程在 `setupMainIpcListener()` 之后、且 `requestSingleInstanceLock()` 成功时才启动 MCP。第二个编辑器实例仍会退出，不会再开一个服务。

服务只监听 `127.0.0.1` 的随机端口。发现文件是 Electron `userData` 下的 `User/agent-mcp.json`（Linux 上通常是 `~/.config/open-plc-editor/User/agent-mcp.json`），权限 `0600`。内容是 `port`、`token`、`pid`、`version`。不要把这个文件提交进 git。

## 怎么跑测试和检查

单元测试模拟工程磁盘、编译器、运行时 HTTPS 和调试器，不调用 `xml2st`、`iec2c`、`arduino-cli`，也不需要真 PLC。

只跑 Agent MCP：

```bash
npx jest --watchAll=false --coverage=false src/main/modules/agent-mcp/agent-mcp.spec.ts
```

类型检查和 lint（CI 同样执行这两条；完整 Jest 在 `.github/workflows/test.yml`）：

```bash
npm run typecheck
npm run lint
npm test
```

`npm run typecheck` 使用 `tsc --noEmit --skipLibCheck`。不加 `--skipLibCheck` 时，当前依赖里的 `@types/node` `Buffer` 和 TypeScript 的 `Uint8Array` 对不上，错误在 `node_modules`，与本次改动无关。

本地如果用 `npm ci --ignore-scripts`，没有 Electron 二进制。现有 `compiler-module.spec.ts` 会在 `require('electron')` 处失败。CI 的 `npm ci` 会安装 Electron。Agent MCP 的 spec 自己 mock 了 `electron`。

## MCP 服务怎么工作

实现不使用 `@modelcontextprotocol/sdk`。主进程用 Node `http` 提供 JSON-RPC 2.0，协议版本 `2025-03-26`。

- 地址：`POST http://127.0.0.1:<port>/` 或 `/mcp`
- 头：`Authorization: Bearer <token>`，`Content-Type: application/json`
- `initialize` 返回 `Mcp-Session-Id`。之后如果带了未知 session，响应 404
- `Host` 必须是 `127.0.0.1` 或 `localhost`。有 `Origin` 时也必须是本机
- token 不对返回 401
- 响应是 `application/json`，没有长连接 SSE。耗时工作返回 `jobId`，用 `job_get` 或资源 `openplc://jobs/{id}` 轮询
- 工具结果同时放在 `content[0].text`（JSON 字符串）和 `structuredContent`。`ok: false` 时 `isError` 为 true
- 成功结果都带 `ok: true`。`pou_get` 的形状是 `{ ok, pou, warnings }`

错误码：`unauthorized`、`locked-by-human`、`job-busy`、`validation`、`main-pou-missing`、`board-unknown`、`awaiting-approval`、`not-found`、`no-project`。

同一时间只有一个编译或下载任务。任务进行中，`project_save` 和其他写操作返回 `job-busy`。任务一开始就放开写锁。应用里用 Electron `MessageChannelMain` 接编译日志；测试用内存端口，契约同样是 `start` / `postMessage` / `close`。

## Agent 怎么调用

1. 读发现文件，带 bearer 调用 `initialize`，再发 `notifications/initialized`。
2. `tools/list` 查看工具。`prompts/list` 有 `edit-via-iec-xml` 和 `compile-and-report`。
3. 资源：`openplc://session`、`openplc://project/xml`、`openplc://hardware/boards`、`openplc://jobs/{id}`。

默认模式是 `supervised`。写操作（`pou_upsert`、`program_apply_xml`、`resource_apply`、`project_save`、`datatype_upsert`、`datatype_delete`、`pou_delete`）先拿 agent 写锁。人正在编辑（`handleFileAndWorkspaceSavedState` 发出 `agent:lock-request`）时，supervised 下人优先，agent 得到 `locked-by-human`。`session_set_mode` 不释放锁。`session_release` 才释放。

| 工具 | 作用 |
| --- | --- |
| `session_info` / `session_set_mode` / `session_release` | 版本、路径、锁、模式 |
| `project_create` / `project_open` / `project_save` / `project_list_recent` | 工程文件 |
| `program_export_xml` / `program_apply_xml` | IEC XML 整份导出和写回 |
| `pou_list` / `pou_get` / `pou_upsert` / `pou_delete` | 单个 POU。不能删除 `main` |
| `datatype_upsert` / `datatype_delete` | array、enum、struct |
| `resource_get` / `resource_apply` | 任务、实例、资源全局变量 |
| `compile_start` / `download_start` / `job_get` | 编译与下载任务 |
| `hardware_boards` / `hardware_ports` | 板卡和串口 |
| `runtime_login` / `runtime_status` / `runtime_start` / `runtime_stop` / `runtime_users` | 运行时。没有创建用户的工具 |
| `debug_compile` / `debug_connect` / `debug_verify_md5` / `debug_read_variables` / `debug_disconnect` | 调试。没有 `debug_set`（Modbus `0x42`） |

`compile_start` 固定 `compileOnly: true`。调用方如果传 `false`，返回 `validation`，并指向 `download_start`。板卡必须是 `hals.json` 的键；名字里有 `..`、`/`、`\` 则是 `board-unknown`。编译参数顺序仍是 `[projectPath, boardTarget, boardCore, compileOnly, projectData, runtimeIpAddress, runtimeJwtToken]`。Python POU 在进入 `compileProgram` 之前，用活动栏同一套函数改写成 ST。

`download_start`、`runtime_start`、`runtime_stop`、`debug_connect` 在 supervised 下要确认。下载立刻返回 `jobId`；拒绝或超时会把任务收成错误日志 `awaiting-approval`。运行时这三个调用会等到允许、拒绝或超时。地址、设备配置、引脚表的变更同样要确认。autonomous 下直接应用，并在控制台记一条，不弹窗。确认超时 60 秒。拒绝或超时会放开写锁。

`project_save` 先向界面要快照，1.5 秒内有回复就用界面副本，否则用会话里的副本。

界面同步通道是 `agent:project-sync`，载荷和打开工程一样。同一路径就地更新，不每次弹 toast。autonomous 且锁在 agent 手上时，工作区 `pointer-events: none`，并显示英文横幅。supervised 不冻结界面。

## 和 IEC 61131-10 的对应

磁盘布局不变：`project.json`、`devices/configuration.json`、`devices/pin-mapping.json`、`pous/**/<name>.json`。`project.json` 里的 `data.pous` 保存时清空，POU 文件才是权威来源。保存会删掉已经移除的 POU 文件。

Agent 导出使用 `XmlGenerator`，方言默认 `old-editor`（`tc6_0201`）。`contentHeader@name` 用工程 `meta.name`。编译器生成的 `plc.xml` 在能读到 `project.json` 时也用这个名字。

| 编辑器 | XML |
| --- | --- |
| ST / IL 正文 | `body/ST` 或 `body/IL` 的文本 |
| POU `class: global` | `interface/globalVars`（以前会被丢掉） |
| 资源全局变量，含 array / derived | 与 POU 变量相同的类型编码，不再把类型粗暴改成大写字符串 |
| LD / FBD 界面 | `addData/openplc` 里的 `graph` JSON。标准 `body/LD` 或 `body/FBD` 仍交给 `xml2st` |
| Python | 只留在 `addData/openplc`。编译前改写成 ST，不会原样进入 `plc.xml` |
| 设备、引脚、调试标记 | `addData/openplc` 里的 JSON 文本。它们不是 IEC 元素 |
| 任务和实例 | 单资源。实例带 `task`。也接受嵌套的 `task/pouInstance` |
| SFC | `pou_upsert` 返回 `validation`。`program_apply_xml` 跳过 SFC POU 并给出警告 |

`addData` 的命名空间是 `http://www.openplcproject.com/xml/openplc`。这段只加在 agent 导出上，不写进编译器的 `plc.xml`，这样 `xml2st` 看到的文档和原来一致。

配置名不是 `Config0` 或资源名不是 `Res0` 时给出警告，仍然落到编辑器唯一的那个资源。多配置或多资源时用第一个并警告。缺 `main` 程序时 `program_apply_xml` 返回 `main-pou-missing`，不保存。LD/FBD 没有 `graph` 时还原成空 rung，并警告视口和 parallel 不能从标准图形还原。

调试编译结束后读取 `build/<board>/src/VARIABLES.csv`，格式 `{index};VAR;{name};{name};{type};`。`job_get` 可以多一个 `variables` 字段，里面是索引。`debug_verify_md5` 读已经连上的那个调试客户端，不另开短连接。调试 TCP 端口 502、超时 5 秒仍是现有客户端的行为。

这不是任意 PLCopen 文件的互操作承诺。对不上的结构会进 `warnings`，或者以 `validation` 拒绝。

## 阶段

1. MCP 骨架、`project_create`、`compile_start`、`job_get`。没有 XML、运行时、调试器。没有渲染进程也能编译。
2. ST/IL 往返、`pou_get` / `pou_upsert`、资源、打开和保存、界面同步、`contentHeader` 名称、POU `globalVars`。
3. 运行时登录、状态、启停、下载，以及 supervised 确认。JWT 写入现有运行时连接。编译任务和保存互斥。
4. 调试编译、连接、校验 MD5、读变量、断开。
5. LD/FBD 图形 `addData`、资源全局 array/derived、SFC 拒绝、设备与引脚往返。

## 实现时定下的选择

设计没有写成唯一答案、但本分支已经定下来的点：

1. 不用 MCP SDK。JSON-RPC，协议 `2025-03-26`，JSON 响应，任务用轮询。
2. 工具 JSON 同时放在 `content[0].text` 和 `structuredContent`。`ok: false` 时 `isError` 为 true。
3. 每个成功结果包含 `ok: true`。`pou_get` 是 `{ ok, pou, warnings }`。
4. 确认超时 60 秒。拒绝或超时：任务记错误日志 `awaiting-approval`；直接返回的工具用错误码 `awaiting-approval`。
5. `project_save` 优先用 1.5 秒内的界面快照，否则用会话副本。
6. `contentHeader@name` 用 `meta.name`。agent 导出和能读到 `project.json` 的编译器 `plc.xml` 都这样。
7. POU 的 `class: global` 写入 `interface/globalVars`。
8. 资源全局变量的 array / derived 与 POU 变量用同一套类型编码。
9. `addData/openplc` 只出现在 agent 导出，不进编译器 `plc.xml`。
10. 设备、引脚、图形、Python、调试标记用 `addData` 里的 JSON 文本，因为它们不是 IEC 元素。
11. 单资源的 `pouInstance` 带 `task`。也接受嵌套的 `task/pouInstance`。
12. SFC 的 `pou_upsert` 是校验失败。`program_apply_xml` 跳过 SFC 并警告。
13. 编译前用活动栏同一套 Python 函数改写成 ST。
14. `compile_start` 永远是只编译。下载走 `download_start`。
15. `debug_verify_md5` 走已连接的单例 `readConnectedDebuggerMd5`。
16. `debug_compile` 成功后，`job_get` 可以带 `variables`。
17. 发现文件权限 `0600`。
18. 人的编辑从 `handleFileAndWorkspaceSavedState` 发 `agent:lock-request`。
19. autonomous 且 agent 持锁时冻结工作区并显示英文横幅。supervised 不冻结，人可以抢走锁。
20. 不提供创建运行时用户的工具。
21. 测试用内存端口，应用用 `MessageChannelMain`。
22. `compile_start` 不重复做 `checkArduinoCliAvailability` / `checkIec2cAvailability`，`compileProgram` 里已经做了。测试 mock 编译器并打出预期日志。
23. `datatype_upsert` 覆盖 array、enum、struct，这样整份导出可以往返，不只是标量。
24. 类型检查命令加 `--skipLibCheck`，避开依赖里已有的 `Buffer` / `Uint8Array` 错误。
