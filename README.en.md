# Codex-Aura

[简体中文](README.md#中文说明) · **English** · [Full English guide](docs/README.en.md)

Adds **Codex** to Aura's model picker, uses the existing Codex login with **GPT-6.1-Sol / Ultra**, and saves real conversations through Codex's app-server protocol. Includes six read-only MCP tools and three skills for diagnostics, Blueprint inspection and Unreal workflows.

[Chinese installation guide](docs/README.zh-CN.md) · [Release notes: English / 中文](docs/RELEASE_NOTES.md) · [MIT license](LICENSE)

## Requirements

Windows, Node.js, a signed-in Codex CLI, Aura 1.0.6, its Unreal plugin and an existing compatible `AuraChatTap.mjs` router. This repository supplies an integration patch; it does not ship the full Aura, DSH, Codex or Unreal products, or the router itself.

Tested with Node.js 24.14.1. Earlier native protocol checks used Codex CLI 0.159.2; the 0.1.5 plugin-load and live save checks used 0.159.0-alpha.12.1. Installation stops if known patch anchors do not match.

## Installation

Create `config.local.json` in the repository root:

```json
{
  "auraRoot": "C:\\Apps\\aura-client",
  "routerRoot": "C:\\Tools\\AuraRouter",
  "routerUrl": "http://127.0.0.1:41777",
  "testProject": "C:\\Projects\\MyGame",
  "cliPath": ""
}
```

Set actual local paths. `routerRoot` must contain the compatible router. `testProject` is diagnostic configuration and does not grant write access. An empty `cliPath` enables discovery of the current CLI.

```powershell
$env:CODEX_AURA_CONFIG = (Resolve-Path .\config.local.json).Path
node .\codex-aura\scripts\install.mjs --config .\config.local.json --dry-run
node .\codex-aura\scripts\install.mjs --config .\config.local.json
```

The plugin process must inherit `CODEX_AURA_CONFIG`; alternatively use `%LOCALAPPDATA%\Aura\CodexAura\config.json`. Installer `--config` does not persist environment variables for desktop processes. Keep the returned checkpoint path. Backups default to `%LOCALAPPDATA%\Aura\CodexAura\backups` and can be relocated with `--backup-root`.

Reload the existing router, open a new Codex chat or restart Codex to refresh tools, and refresh Aura's model menu. See the [full English guide](docs/README.en.md) for checkpoint restoration and native Project association.

## Save fix in 0.1.5

A newly started Codex thread may have no persisted rollout before its first turn. The bridge now records the real thread identity, completes generation, then attempts optional Project/workspace/title synchronization within one five-second deadline. Synchronization errors preserve the answer. Cloud save receipts are validated, so failures cannot be reported as committed.

Live verification created a conversation, continued the same native and Aura conversation, and read back all four stored messages. Private verification records are excluded from the public repository.

## Development and boundaries

```powershell
npm test
```

No npm dependencies are required. Tests use isolated router, MCP and app-server fixtures. The six plugin tools are read-only; Ask/Plan stay read-only, while Aura Agent edits still require the existing router's authorization and exact project scope. The integration does not edit Codex's internal database, copy credentials or fabricate conversation content. Image, audio and file attachments are currently rejected explicitly.

The project follows functionality and workflow references from [DSH-Aura](https://github.com/TaoKing2023/DSH-Aura). See [third-party notices](THIRD_PARTY_NOTICES.md).
