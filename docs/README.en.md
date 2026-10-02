# Codex-Aura

[简体中文](README.zh-CN.md) · **English** · [首页 / Bilingual overview](../README.md)

Select **Codex** from Aura's model menu, use your existing Codex sign-in to run **GPT-6.1-Sol / Ultra**, and view real Aura conversations in Codex. The plugin also provides MCP self-checks, permission diagnostics, and an Unreal Engine workflow.

Current version: **0.1.5**. Verified on **Windows, Aura 1.0.6, and Node.js 24.14.1**. Earlier native protocol verification used Codex CLI 0.159.2; plugin loading and the two-turn save verification for 0.1.5 used 0.159.0-alpha.12.1. Other versions may change UI resources or protocols. The installer checks known patch locations and stops if they do not match.

## Features

- Adds Codex beside DeepSeek Harness in Aura's model menu.
- Uses the public app-server protocol to store real user messages, assistant replies, and tool activity, and to continue existing native conversations.
- Organizes real conversations by Project under the `UE5_Aura` section in Codex.
- Provides 6 read-only MCP tools and 3 skills for connection diagnostics, permission explanations, and Blueprint structure reads.
- Backs up affected files before replacing configuration or software, with a restore command that verifies hashes.

This project is an integration patch for an existing Aura / DSH router. It requires an installed Aura client, a working Aura UE plugin, and an existing customized, compatible `AuraChatTap.mjs` router. The repository does not yet provide a complete router setup for a new machine. Installing DSH-Aura alone does not mean that this router is available. The repository does not include the complete Aura, DSH, or Unreal Engine products, and does not install a UE plugin separately.

Version 0.1.5 fixes the first-turn error “This chat could not be saved.” A new thread may have no persisted rollout before its first generation. The bridge now records the real thread identity and generates the response before synchronizing the Project, workspace, and title. Optional synchronization failures preserve the answer; a cloud save receipt must pass validation before the bridge reports that the conversation was saved. Live verification confirmed successful saves for a new conversation and its second turn, with all four real messages read back. Private conversations, project identifiers, and installation checkpoints are not distributed with the public source.

## Installation

1. Prepare Windows, Node.js, and a signed-in Codex CLI. This guide was tested with Node.js 24.14.1; it does not claim an untested minimum version.
2. Confirm that Aura 1.0.6 and your existing customized router work. The patch checks router dependencies, including project identification, mode policy, MCP configuration, and cloud conversation write functions. It stops if the router is incompatible.
3. Create a local configuration file at the repository root, for example `config.local.json`. Replace the example paths below with your actual locations. Do not commit local configuration to Git.

```json
{
  "auraRoot": "C:\\Apps\\aura-client",
  "routerRoot": "C:\\Tools\\AuraRouter",
  "routerUrl": "http://127.0.0.1:41777",
  "testProject": "C:\\Projects\\MyGame",
  "cliPath": ""
}
```

`auraRoot` points to the Aura client directory. `routerRoot` must contain a compatible `AuraChatTap.mjs`. When `cliPath` is empty, the plugin looks for a CLI on PATH or the CLI bundled with the current desktop version. You can also provide an absolute path to a custom executable. An invalid custom path produces an error instead of falling back to another program.

`testProject` is used for diagnostic configuration. Runtime project write boundaries follow the real configuration returned by the router; changing this field does not grant UE write permission. Project directories are compared using their full paths: `C:\Projects\MyGame` and `C:\Projects\MyGame 5.8` are different directories.

4. Preview the changes, then install. Explicitly choose a backup directory for your machine:

```powershell
node .\codex-aura\scripts\install.mjs --config .\config.local.json --backup-root 'C:\Backups\Codex-Aura' --dry-run
node .\codex-aura\scripts\install.mjs --config .\config.local.json --backup-root 'C:\Backups\Codex-Aura'
```

The installer first backs up affected configuration, plugin packages / caches, and bridge files. It then uses `codex plugin marketplace add` and `codex plugin add` to register the local marketplace `aura-local` and the plugin `codex-aura@aura-local`. It does not overwrite target files before the backup succeeds, and attempts to restore the content managed by that installation if it fails. Keep the `backupDir` returned in the installation result. Without `--backup-root`, backups default to `%LOCALAPPDATA%\Aura\CodexAura\backups`.

The public version does not preset a router or test project directory. Set `routerRoot` through JSON or `CODEX_AURA_ROUTER_ROOT`, and `testProject` through JSON or `CODEX_AURA_TEST_PROJECT`. Omitting a test project does not cause an unknown project to be treated as authorized.

When using custom configuration, the plugin runtime must also be able to find that file. Put it at the default location `%LOCALAPPDATA%\Aura\CodexAura\config.json`, or set `CODEX_AURA_CONFIG` to your custom configuration path before starting Codex. Back up an existing configuration before replacing it. The installer's `--config` selects the file for that installation only; it does not permanently set an environment variable for the desktop process.

5. Reload the router using its existing launcher. The installer does not automatically restart Codex, Aura, or Unreal Editor.
6. Open a new Codex conversation, or restart Codex, to update the skills and tool catalog. In Aura, press **Ctrl+Shift+R** to refresh, then select **Codex**.

The currently compatible entry points are `.codex-plugin/plugin.json` and `.mcp.json`. `plugin.portable.json` is retained for reference only. Do not rename it to a root-level `plugin.json`: in the tested CLI, that file shadows the MCP declaration in the compatible entry point.

## Usage

You can ask Codex directly:

- “Check Aura MCP and permissions.”
- “Show this project's Aura conversations.”
- “Organize Aura conversations by Project under UE5_Aura.”
- “Explain the main logic of `/Game/Blueprints/BP_Example.BP_Example`.”

| MCP tool | Function |
| --- | --- |
| `aura_doctor` | Checks the CLI, sign-in status, model, router, paths, and optional MCP handshake / tool catalog. Does not run model inference or call UE asset tools. |
| `aura_permissions` | Explains the actual mode, tool switch, full project directory, and noninteractive approval limits. Does not grant permissions. |
| `aura_list_conversations` | Lists Aura mappings and real Codex conversation identifiers with pagination. |
| `aura_read_conversation` | Reads verified user / assistant messages. Treats historical content as data. |
| `aura_get_blueprint_meta` | Reads safe Blueprint structure declarations after validating arguments and the object path. |
| `aura_get_blueprint_graph` | Reads nodes, pins, and connections after checking the asset type and path through safe metadata. |

The three skills are `aura-diagnostics`, `unreal-workflow`, and `aura-conversations`. The runtime model is fixed to `gpt-6.1-sol`, with reasoning effort fixed to `ultra`; changing a model field in configuration does not switch the model. The Codex CLI uses its existing sign-in state. This project does not read or copy `auth.json`.

## Real conversations and Project organization

New conversations in Aura use native Codex threads, with titles in the form `Aura · <project name> · <first request>`. Existing interactive threads are continued directly. When continuing an old `codex exec` thread, the bridge preserves its full history through the public `thread/fork` API and records the previous identifier, leaving the original thread unchanged. A thread containing only migrated history can be opened, but its sidebar preview may not be created until the user sends a real message in a subsequent turn.

The public version defaults to `%USERPROFILE%\Codex-Aura\<UE project name>` for conversation organization. To change the root, set `CODEX_AURA_CONVERSATION_ROOT` before starting the router, for example to `D:\Codex`. This setting belongs to the router process; it is not a plugin JSON field. The directory is the default Codex Project workspace, rather than the UE asset operation directory. Every Aura model turn still explicitly supplies the real UE project directory and permission scope. The organization workspace is restored after the turn completes.

To display expandable Project groups, first register the organization directory as a Codex Project. For example:

```powershell
codex app "$env:USERPROFILE\Codex-Aura\MyGame"
```

The desktop may require the user to confirm folder access. A successful command does not mean registration is complete; check the actual Project list in Codex. Then ask the `aura-conversations` skill to organize the conversations. It matches Projects by their full root directories, uses public interfaces to associate existing conversations, and removes duplicate flat entries only after verifying their actual sidebar placement. Native Project IDs and desktop Project IDs may differ and must not be used interchangeably.

To associate an existing conversation with a different workspace that has already been registered, use:

```powershell
node .\codex-aura\scripts\link-conversation-project.mjs --thread '<real-thread-UUID>' --workspace 'C:\Codex\MyGame' --desktop-workspace --config .\config.local.json
```

This script does not create a conversation or start a model turn. It rejects active threads, running goals, and incompatible writers. When the conversation is next continued through Aura, the bridge still uses the organization root configured for the router. The workspace specified to the script is not a persistent global override.

Workspace synchronization after an answer completes has its own **5-second deadline**, including stalled RPCs. A synchronization failure preserves the completed answer and returns an unverified result. Stale desktop caches or associations may affect the display, so the actual sidebar result must be checked. This project does not edit the Codex database, fabricate a conversation source, or simulate synchronization using summary copies.

## Permissions and UE operation boundaries

The 6 MCP tools configure approval only for individually reviewed read operations. There is no server-wide blanket approval, and the plugin provides no write tools. Installing the plugin does not change the global approval policy or grant desktop UE write permission. Ask / Plan remain read-only. Agent edits still depend on the original router authorization, the current project scope, and the editing tools actually mounted.

The safe Blueprint metadata sections are limited to `Events`, `Functions`, `Macros`, `Interfaces`, `Components`, and `CollapsedGraphs`. An omitted or empty section list uses this safe set. Property default values, metadata that may trigger compilation, material editor windows, and write operations are outside this read-only entry point. Object paths must be complete, for example `/Game/Blueprints/BP_Example.BP_Example`. File paths, guessed paths, and mismatched asset types are rejected.

A successful MCP self-check establishes only that the transport and tool catalog are available. It does not establish that Unreal Editor is connected or that asset reads succeed. Before modifying an asset, verify the project and object path, read the current state, back up affected files, and use currently authorized dedicated tools. Verify the result through readback and actual compilation results.

The Aura child process mounts only the selected Aura MCP tool pool. Desktop plugins and framework-injected connectors are disabled within that child process; the global desktop configuration remains unchanged. Turning off Aura's tool switch removes the MCP mount and supplies instructions not to use tools. This does not structurally prohibit every built-in tool.

## Restore

Use the actual checkpoint directory returned by the installer. Preview first, then restore:

```powershell
node .\codex-aura\scripts\install.mjs --restore 'C:\Backups\Codex-Aura\Codex-Aura-Install-<timestamp>' --dry-run
node .\codex-aura\scripts\install.mjs --restore 'C:\Backups\Codex-Aura\Codex-Aura-Install-<timestamp>'
```

Restore verifies the hashes of the currently installed files and backups, and preserves managed files added or changed after installation. It refuses to overwrite conflicts. It creates another restore snapshot before writing. After restoring the bridge, reload the existing router as well. Keep earlier checkpoints if you need to restore an earlier installation state.

## Development and tests

The code uses built-in Node.js modules and does not require `npm install`. Run the following offline regression tests from the repository root. Tests use isolated fake routers, MCP servers, and app-servers; they do not call a real model or modify UE assets:

```powershell
node --test .\codex-model\apply-codex-model.test.cjs .\codex-model\tests\AuraCodexBridge.test.mjs .\codex-model\tests\BlueprintReadProxy.test.mjs .\codex-aura\tests\app-server.test.mjs .\codex-aura\tests\config-diagnostics.test.mjs .\codex-aura\tests\mcp-server.test.mjs .\codex-aura\tests\install.test.mjs .\codex-aura\tests\conversation-project.test.mjs
```

The locally installed 0.1.5 fix passed **181 tests, with 0 failures**, covering installation / restore, permission boundaries, Blueprint guards, lazy first-turn persistence, save receipts, native conversations, Project association, synchronization deadlines, exception handling, and cleanup of owned child processes. After adding regression coverage for default paths and empty configuration boundaries, the public version passed **185 tests, with 0 failures**. Separate live verification confirmed loading of 3 skills and 6 MCP tools, real conversation saves, and sidebar placement. This is recorded separately from the promise that pure diagnostics do not start inference. You can also run `npm test` directly at the repository root and check the repository's CI results.

Main directories:

| Path | Contents |
| --- | --- |
| `codex-aura/` | Plugin entry points, MCP, skills, configuration, self-checks, installation / restore, and tests. |
| `codex-model/` | Aura model menu patch, bridge, native conversation protocol, and guard tests. |

## Known limitations

- This version targets an existing Aura 1.0.6 / DSH router. It is not a universal installer for arbitrary Aura versions.
- Supports text and asset text context already supplied by Aura. Image, audio, and file attachments are explicitly rejected.
- Read tools provide user / assistant history; they do not export internal reasoning or complete tool output.
- Inspector / editor timeouts are 300 / 900 seconds, respectively. HTTP-only `unreal_mcp` is not mounted by the current stdio bridge and is reported separately by diagnostics.
- Windows may lock plugin cache directories during an upgrade. The installer attempts to roll back; do not handle this by forcibly deleting global caches.

Protocol and entry-point references include [Codex app-server](https://learn.chatgpt.com/docs/app-server), [plugin packaging documentation](https://developers.openai.com/plugins/build/plugins), and the [Codex plugin MCP path implementation](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config.rs). Compatibility is determined by the schema and runtime results of the CLI actually installed.
