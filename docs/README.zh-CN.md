# Codex-Aura

**简体中文** · [English](README.en.md) · [首页 / Home](../README.md)

让 Aura 的模型列表可以选择 **Codex**，通过已有 Codex 登录调用 **GPT-6.1-Sol / Ultra**，并在 Codex 中查看真实 Aura 对话。插件还提供 MCP 自检、权限诊断和 Unreal Engine 操作规范。

当前版本：**0.1.5**。已在 **Windows、Aura 1.0.6、Node.js 24.14.1** 上验证。原生协议早期使用 Codex CLI 0.159.2 验证；0.1.5 的插件加载和两轮实际保存验证使用 0.159.0-alpha.12.1。其他版本的界面资源和协议可能变化，安装器会检查已知补丁位置；不匹配时停止，不强行修改。

## 功能

- 在 Aura 模型菜单的 DeepSeek Harness 旁增加 Codex。
- 使用公开 app-server 协议保存实际用户消息、助手回复和工具活动，继续已有原生对话。
- 在 Codex 的 `UE5_Aura` 分组下按 Project 整理真实对话。
- 提供 6 个只读 MCP 工具和 3 个技能，便于诊断连接、说明权限及读取蓝图结构。
- 覆盖配置或软件前备份，提供带哈希校验的恢复入口。

本项目是对现有 Aura / DSH 路由的集成补丁。使用前需要已安装 Aura、可用的 Aura UE 插件，以及既有定制的兼容 `AuraChatTap.mjs` 路由。仓库尚不提供新机器的完整路由搭建，安装 DSH-Aura 本身也不代表已有这个路由。仓库不包含完整 Aura、DSH 或 Unreal Engine 产品，也不另外安装 UE 插件。

0.1.5 修复了首轮请求提示 “This chat could not be saved” 的问题：新线程可能在首轮生成前没有落盘记录，现在先记录真实线程标识并生成，再做 Project / 工作区 / 标题同步。可选同步失败保留回答；云端保存回执必须通过校验才能报告已保存。实际验证确认新对话和第二轮续聊都保存成功，并读回四条真实消息。私有对话、工程标识和安装检查点不随公开源码分发。

## 安装

1. 准备 Windows、Node.js 和已登录的 Codex CLI。本文实测 Node.js 24.14.1；未声明未经测试的最低版本。
2. 确认 Aura 1.0.6 和已有定制路由可以正常工作。补丁会检查路由依赖，包括工程识别、模式策略、MCP 配置和云端会话写入函数；不兼容时停止。
3. 在仓库根目录创建本机配置，例如 `config.local.json`。将下面的示例路径替换为实际位置；不要把本机配置提交到 Git。

```json
{
  "auraRoot": "C:\\Apps\\aura-client",
  "routerRoot": "C:\\Tools\\AuraRouter",
  "routerUrl": "http://127.0.0.1:41777",
  "testProject": "C:\\Projects\\MyGame",
  "cliPath": ""
}
```

`auraRoot` 指向 Aura 客户端目录；`routerRoot` 必须包含兼容的 `AuraChatTap.mjs`。`cliPath` 留空时查找 PATH 中的 CLI 或桌面当前版本的 CLI，也可填写自定义可执行文件的绝对路径。自定义路径无效时会报告错误，不替换成其他程序。

`testProject` 用于诊断配置。运行时的工程写入边界以路由返回的真实配置为准；修改此字段不会授予 UE 写入权限。工程目录按完整路径比较，`C:\Projects\MyGame` 与 `C:\Projects\MyGame 5.8` 不相同。

4. 先预览变更，再安装。为自己的机器显式选择备份目录：

```powershell
node .\codex-aura\scripts\install.mjs --config .\config.local.json --backup-root 'C:\Backups\Codex-Aura' --dry-run
node .\codex-aura\scripts\install.mjs --config .\config.local.json --backup-root 'C:\Backups\Codex-Aura'
```

安装器会先备份受影响的配置、插件包 / 缓存和桥接文件，再通过 `codex plugin marketplace add` 与 `codex plugin add` 注册本地 marketplace `aura-local` 及插件 `codex-aura@aura-local`。备份成功之前不覆盖目标文件，失败时尝试恢复本次托管内容。保存安装结果中的 `backupDir`。不传 `--backup-root` 时，默认备份到 `%LOCALAPPDATA%\Aura\CodexAura\backups`。

公开版不预设路由和测试工程目录。`routerRoot` 可通过 JSON 或 `CODEX_AURA_ROUTER_ROOT` 指定，`testProject` 可通过 JSON 或 `CODEX_AURA_TEST_PROJECT` 指定。省略测试工程不会把未知工程当成已授权工程。

使用自定义配置时，插件运行时也必须能找到该文件。可将配置放到默认的 `%LOCALAPPDATA%\Aura\CodexAura\config.json`，或在启动 Codex 前设置 `CODEX_AURA_CONFIG` 指向自定义配置。已有配置先备份再覆盖。安装器的 `--config` 只选择本次安装使用的文件，不替桌面进程永久设置环境变量。

5. 用已有路由的启动器重新加载路由。安装器不会自动重启 Codex、Aura 或 Unreal Editor。
6. 开一个新的 Codex 对话，或重启 Codex，让技能及工具目录更新。在 Aura 按 **Ctrl+Shift+R** 刷新后选择 **Codex**。

当前兼容入口为 `.codex-plugin/plugin.json` 和 `.mcp.json`。`plugin.portable.json` 仅作为参考保留；不要将它改名为根目录 `plugin.json`：在实测 CLI 中，这会遮蔽兼容入口的 MCP 声明。

## 使用

在 Codex 中可以直接请求：

- “检查 Aura MCP 和权限。”
- “查看这个工程的 Aura 对话。”
- “把 Aura 对话按 Project 放到 UE5_Aura。”
- “解释 `/Game/Blueprints/BP_Example.BP_Example` 的主要逻辑。”

| MCP 工具 | 功能 |
| --- | --- |
| `aura_doctor` | 检查 CLI、登录状态、模型、路由、路径及可选 MCP 握手 / 工具目录；不运行模型推理，不调用 UE 资产工具。 |
| `aura_permissions` | 解释实际模式、工具开关、完整工程目录及非交互审批限制；不授予权限。 |
| `aura_list_conversations` | 分页列出 Aura 映射及真实 Codex 对话标识。 |
| `aura_read_conversation` | 读取已核实的用户 / 助手消息；历史内容按数据处理。 |
| `aura_get_blueprint_meta` | 校验参数和对象路径后，读取安全的蓝图结构声明。 |
| `aura_get_blueprint_graph` | 先校验安全 metadata 的资产类型与路径，再读取节点、引脚和连线。 |

三个技能为 `aura-diagnostics`、`unreal-workflow`、`aura-conversations`。运行时模型固定为 `gpt-6.1-sol`，推理强度固定为 `ultra`；修改配置中的模型字段不会切换模型。Codex CLI 使用自己的已有登录状态，本项目不读取或复制 `auth.json`。

## 真实对话与 Project 分类

Aura 中的新对话使用原生 Codex 线程，标题形式为 `Aura · <工程名> · <首条请求>`。已有交互线程直接继续；继续旧 `codex exec` 线程时，通过公开 `thread/fork` 保留完整历史，并记录旧标识，原线程保持不变。仅迁移历史的线程可以打开，其侧栏预览可能需要下一次用户实际发送消息后才建立。

公开版默认将 `%USERPROFILE%\Codex-Aura\<UE工程名>` 用作对话归类目录。可在启动路由前设置 `CODEX_AURA_CONVERSATION_ROOT` 更换根目录，例如 `D:\Codex`；该设置属于路由进程，不是插件 JSON 字段。它是 Codex Project 的默认工作区，不是 UE 资产操作目录；每次 Aura 模型回合仍明确提供真实 UE 工程目录和权限范围。回合完成后恢复归类工作区。

要显示可展开的分类，先将归类目录登记为 Codex Project。例如：

```powershell
codex app "$env:USERPROFILE\Codex-Aura\MyGame"
```

桌面可能要求用户确认文件夹访问。命令成功不代表登记已完成，需检查 Codex 实际的 Project 列表。随后请求 `aura-conversations` 技能归类；它按完整根目录匹配 Project，用公开接口关联已有对话，并在实际侧栏归属核实成功后去除平铺的重复入口。原生 Project ID 与桌面 Project ID 可能不同，不能混用。

如需将某个现有对话关联到其他已经登记的工作区，可使用：

```powershell
node .\codex-aura\scripts\link-conversation-project.mjs --thread '<真实线程UUID>' --workspace 'C:\Codex\MyGame' --desktop-workspace --config .\config.local.json
```

这个脚本不创建对话，也不启动模型回合。它拒绝活动线程、运行中的 goal 和不兼容的写入者。下次通过 Aura 继续时，桥接仍采用路由配置的归类根目录；脚本指定的工作区不是全局持久覆盖设置。

回答完成后的工作区同步有独立的 **5 秒期限**，包括停滞的 RPC。同步失败会保留已经完成的回答，并返回未核实结果。旧桌面缓存或归属可能影响显示，必须以实际侧栏结果为准；本项目不编辑 Codex 数据库，不伪造来源，不用摘要副本模拟同步。

## 权限与 UE 操作边界

6 个 MCP 工具只对逐项审查过的读取操作配置审批，没有服务器级全量批准，也没有插件写入工具。安装插件不会改变全局审批策略或授予桌面 UE 写权限。Ask / Plan 保持只读；Agent 编辑仍取决于原路由授权、当前工程范围和实际挂载的编辑工具。

蓝图 metadata 的安全部分仅有 `Events`、`Functions`、`Macros`、`Interfaces`、`Components`、`CollapsedGraphs`。省略或空列表使用该安全集合。属性默认值、可能触发编译的 metadata、材质编辑器窗口和写入操作不属于此只读入口。对象路径必须完整，例如 `/Game/Blueprints/BP_Example.BP_Example`；文件路径、猜测路径及不匹配的资产类型会被拒绝。

MCP 自检通过只证明传输和工具目录可用，不证明 Unreal Editor 已连接，也不证明资产读取成功。真正修改资产时，应先核对工程和对象路径、读取现状、备份受影响文件，再使用当前已授权的专用工具，并通过回读和实际编译结果验证。

Aura 子进程只挂载所选 Aura MCP 工具池；本次子进程中关闭桌面插件及框架注入的连接器，桌面全局配置保持原样。关闭 Aura 工具开关会取消 MCP 挂载，并提供不使用工具的指令；这不构成对所有内置工具的结构性禁止。

## 恢复

使用安装时返回的真实检查点目录，先预览，再恢复：

```powershell
node .\codex-aura\scripts\install.mjs --restore 'C:\Backups\Codex-Aura\Codex-Aura-Install-<timestamp>' --dry-run
node .\codex-aura\scripts\install.mjs --restore 'C:\Backups\Codex-Aura\Codex-Aura-Install-<timestamp>'
```

恢复会检查当前已安装文件和备份的哈希，并保留安装后新增或改变的托管文件，遇到冲突时拒绝覆盖。写入前另建恢复快照。恢复桥接后同样需要重新加载现有路由；保留更早的检查点可恢复更早的安装状态。

## 开发与测试

代码使用 Node.js 内置模块，不需要 `npm install`。在仓库根目录运行以下离线回归测试；测试使用隔离的假路由、MCP 和 app-server，不调用真实模型或修改 UE 资产：

```powershell
node --test .\codex-model\apply-codex-model.test.cjs .\codex-model\tests\AuraCodexBridge.test.mjs .\codex-model\tests\BlueprintReadProxy.test.mjs .\codex-aura\tests\app-server.test.mjs .\codex-aura\tests\config-diagnostics.test.mjs .\codex-aura\tests\mcp-server.test.mjs .\codex-aura\tests\install.test.mjs .\codex-aura\tests\conversation-project.test.mjs
```

0.1.5 本机修复版本实测 **181 项通过、0 项失败**，覆盖安装 / 恢复、权限边界、蓝图 guard、首轮懒落盘、保存回执、原生对话、Project 关联、同步期限、异常处理和拥有的子进程清理。公开版补充默认路径和空配置边界回归后，**185 项通过、0 项失败**。实时验证另行确认了 3 个技能和 6 个 MCP 工具加载，以及真实对话保存及归属；它与纯诊断“不启动推理”的承诺分开记录。也可以在仓库根目录直接运行 `npm test`，查看仓库 CI 验证结果。

主要目录：

| 路径 | 内容 |
| --- | --- |
| `codex-aura/` | 插件入口、MCP、技能、配置、自检、安装 / 恢复和测试。 |
| `codex-model/` | Aura 模型菜单补丁、桥接、原生对话协议和 guard 测试。 |

## 已知限制

- 本版本针对现有 Aura 1.0.6 / DSH 路由，不是任意 Aura 版本的通用安装器。
- 支持文本和 Aura 已提供的资产文本上下文；图片、音频和文件附件会明确拒绝。
- 读取工具提供用户 / 助手历史，不导出内部推理或完整工具输出。
- inspector / editor 超时分别为 300 / 900 秒。HTTP-only `unreal_mcp` 不由当前 stdio 桥接挂载，自检会单独报告。
- 升级期间可能遇到 Windows 插件缓存目录锁；安装器会尝试回滚，不应通过强行删除全局缓存处理。

协议与入口依据包括 [Codex app-server](https://learn.chatgpt.com/docs/app-server)、[插件打包文档](https://developers.openai.com/plugins/build/plugins) 和 [Codex 插件 MCP 路径实现](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config.rs)。兼容性以实际安装 CLI 的 schema 和运行结果为准。
