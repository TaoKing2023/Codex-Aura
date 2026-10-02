---
name: unreal-workflow
description: 在 Aura 或 Codex-Aura 中定位、读取、修改并验证当前 Unreal Engine 工程的蓝图及其他资产。适用于 UE 资产操作，不用于普通软件开发或单独设置 Codex 模型。
---

# Unreal 工程操作

按用户的实际任务完成操作，并给出可核验的结果。用户已经授权的范围无需重复确认；技能本身不授予工程写入、消息发送、部署或其他外部操作权限。

## 定位工程与工具

- 用 `aura_doctor` 与 `aura_permissions` 核对配置、工程目录、运行模式和实际可用工具。MCP 握手和工具目录可达不等于编辑器连接成功；安全资产实际回读才能确认这一层连接。
- 需要编辑器选择信息时，仅在当前权限允许相应副作用且工具已提供的情况下使用 `get_unreal_context`；原始工具可能导出预览 PNG，不把它默认当成纯只读。否则从用户提供的路径、已允许的查询工具和安全回读定位。工具名称以当前工具目录和输入 schema 为准。
- 对齐编辑器返回的工程和目标资产。`quicksearch` 的磁盘路径可能属于其他工程，不能直接当作当前工程资产。
- 资产读取使用规范软对象路径，例如 `/Game/Folder/BP_Name.BP_Name`。不接受磁盘文件路径、`..`、省略对象名的包路径或其他工程的猜测路径。插件资产必须先核实其挂载点。
- 此集成的模型为 `gpt-6.1-sol`，推理强度 `ultra`。重工具超时为 inspector 300 秒、editor 900 秒；超时后先确认连接和执行结果，避免重复提交尚在执行的写操作。

## 先读取资产

- 蓝图结构与节点连线优先使用 `aura_get_blueprint_meta({asset_path, parts?})` 与 `aura_get_blueprint_graph({asset_path, strand_names})`，或桥接中明确受同一 guard 保护的 `get_asset_meta`、`get_asset_graph`。不能仅凭工具名含 `get`、`read` 或 `readonly` 判定无副作用。
- 安全 metadata parts 仅有 `Events`、`Functions`、`Macros`、`Interfaces`、`Components`、`CollapsedGraphs`；省略或空列表代表完整安全集。不要请求 `PropertyValues`、`Declarations`、`MaterialParams` 或未知 parts。原始 metadata 的属性读取可能隐含蓝图编译。
- graph 入口必须先由安全 metadata 确认资产类型为 Blueprint、返回 Path 与请求完全一致。按返回的真实图名读取节点、引脚和连线；构造函数的内部图名通常为 `UserConstructionScript`。材质原始 graph 读取会打开编辑器窗口，不能按蓝图安全入口处理。
- 需要变量值或 specifiers 时，使用当前权限中实际开放的专用读取工具。未读取到的属性或连线标为未核实，不从蓝图文件名推断逻辑。

## 确认模式与实际授权，再备份

- Ask 与 Plan 保持只读，不编译、写盘或调用编辑工具。Agent 仍需满足当前工程闸门、工具审批配置和用户授权范围；不要假设安装插件就有写权限。
- 用户要求修改且当前权限允许时继续执行。若缺能力，使用 `aura_doctor`、`aura_permissions` 查清具体工具和拒绝原因；权限错误要原样概括，并说明受影响步骤。不要自动切 Agent、降低审批限制或换 Python、路径、工具绕过拒绝。
- 修改资产、源码、配置，或升级和覆盖软件前，先按用户和当前工程的约定备份本次实际影响的原文件，记录原始绝对路径以便恢复。没有指定位置时，选择工程 Content 目录之外的可用备份目录；安装器备份默认位于用户本地数据目录下的 `Aura\CodexAura\backups`。
- 将已经核实的软对象路径映射到对应工程或插件的实际磁盘文件，包含存在的 `.uasset` 配套文件；影响范围不确定时备份相关子目录。不要把备份放进会被资产注册表扫描的 Content 目录。无法完成必要备份时，说明实际阻碍并停止依赖该备份的写操作。

## 加载对应 Aura 最佳实践并编辑

动手修改前，调用已提供的专用指南工具；按任务取需要的内容即可：

| 任务 | Aura 指南 |
| --- | --- |
| 蓝图 | `fetch_blueprint_best_practices` |
| UMG | `fetch_ui_best_practices` |
| Enhanced Input | `fetch_enhanced_input_skill`，`enhanced_input_guide` |
| 材质 | `fetch_material_best_practices`，按实际 category |
| Niagara | `fetch_niagara_best_practices`，必要时 `fetch_niagara_skill` |
| GAS / 时间轴 / Python | 相应 `fetch_gas_best_practices`、`fetch_timeline_best_practices`、`fetch_python_best_practices` |
| 关卡、地形、PCG / 性能 | 相应 `fetch_level_design_skill` / `fetch_performance_best_practices` |

指南不可用时说明缺失；已有明确工具 schema 和工程规范足够支持的简单修改可继续，不把指南缺失当成额外审批。

- 单一属性、变量、组件或结构修改优先用 `unreal_editor` 已开放的具体工具；蓝图事件图、节点和引脚连线适用 `bp_agent`。调用前核对实际 permission policy；新的只读插件入口不授予这些工具权限。
- 蓝图变量 Category / Tooltip 用 `edit_blueprint` 的 `specifiers`，并为只改元数据的属性提供明确 `type_hints`；不要以缺省 null 值让工具猜类型。函数 Description 和节点注释使用支持它们的具体工具或 `bp_agent`，不要用不支持该属性的反射写入。
- UE 5.8 某些 `BlueprintEditorLibrary` 图、节点、引脚 Python API 可能不可用。优先使用 Aura 的校验工具；只把本次工具实际返回的行为写作已验证事实，不照搬旧版 API 假设。
- 编辑风格和语言跟随当前工程及用户要求；Tooltip、函数 Description 和流程注释解释用途、触发时机和副作用，不另建无关规范。

## 回读验证与交付

- 用允许的读取入口核验具体变化：变量值和 specifiers、组件属性、节点及引脚连线。需要编译的修改只在授权的可写模式编译，再读取实际编译结果及相关输出日志。
- 区分工具返回成功、回读一致、编译通过和运行时验证；仅报告本次实测到的层级。部分失败时核实已经落地的变化，再决定是否在既有授权范围内修复或恢复，避免盲目重复写入。
- 默认中文交付，先说完成了什么，再给资产路径、关键回读值和必要限制；附简短适用规范即可。用户只要分析或方案时，交付相应分析或方案。
- 报告语言和交付格式遵循用户要求；需要交接时，将直接相关的源码、补丁、测试和说明一起打包。没有实际验证的行为明确标注。
