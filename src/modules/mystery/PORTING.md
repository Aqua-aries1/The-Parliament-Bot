# 神秘指令小游戏：双宿主移植边界

目标：本模块的双骗子游戏（骗子酒馆 / 骗子骰子，及后续同类小游戏）要能同时运行在两个宿主：

- **parliament-bot**（上游，走 PR）
- **MutsumiBot**（睦子米）

## 可移植性纪律（改代码前必读）

1. `core/*.js` 引擎只准 require node 内置——纯状态机，不碰 discord.js、不碰宿主任何设施。
2. 游戏运行链路（command → services → utils）只依赖模块内文件 + discord.js v14。
3. 新的宿主能力（权限校验、配置、频道访问）不许直接进运行链路；确需引入时先在本文档登记。

## 依赖审计结论（2026-09-08）

- `core/liarsBarEngine.js`、`core/liarsDiceEngine.js`：零模块外依赖 ✓
- `liarsBarGame` / `liarsDiceGame` 依赖闭包：`mysteryGameManager`、`mysteryNicknameLock`(+Service)、
  `liars*ResumeStore`（复用 `devilRouletteResumeStore` 工厂，仅路径/日志前缀不同）、各自 engine——全模块内 ✓
- `mysteryCommand` 依赖：模块内 + discord.js ✓
- 模块内引用宿主的只有设置/管理链路（见下表「需适配」行）

## 宿主触点清单（移植 = 重接这 5 根线 + 适配 1 处）

| 触点 | 宿主位置 | 模块出口 |
|---|---|---|
| 命令注册 | 宿主命令加载器 | `commands/mysteryCommand.js` |
| 交互转发 | `core/events/interactionCreate.js` | `services/interactionHandler`（customId 前缀 `mystery_`） |
| 启动恢复 | `core/events/clientReady.js` | 各 game 的 `restoreActiveGames(client)` |
| 成员失效 | `core/index.js` → `modules/mystery/events/guildMember{Remove,Update}.js` | `mysteryGameManager.handleGuildMember{Remove,Update}` |
| 优雅关停 | `core/index.js` 收尾 | `mysteryGameManager.shutdownAllGames()` |
| 需适配 | `core/utils/permissionManager`、`safetySetup` | 仅 `mysterySettingsCommand`、`manageCommand`、`channelAccessManager`、`namePoolManager` 引用（设置与管理链路，游戏运行不依赖） |

## 移植步骤 checklist

1. 拷贝 `src/modules/mystery/` 整目录（本文件随行）。
2. 确认目标宿主 discord.js 为 v14（组件、ephemeral、MessageFlags 用法依赖 v14 API）。
3. 按上表接 5 根线。
4. 适配 permissionManager：映射到目标宿主的权限体系，或为两宿主各写一个薄实现。
5. 数据目录 `data/mystery/*.json` 相对进程 CWD；确认目标宿主不把 `data/` 提交进版本库。
6. 冒烟验收：起一局酒馆 + 骰子 → 进程重启验证断点续传 → 触发一次出局惩罚流。

## 已知宿主差异备忘

- 惩罚执行（禁言/改名）用 Discord 原生 timeout + 昵称修改，两宿主通用。
- 惩罚时长是模块内常量（`penaltyMinutes`），无 env / 配置依赖。
- 2026-09-08 快照存储去重：liars 两个 store = `devilRouletteResumeStore` 工厂 + 不同 `filePath` / `logTag`，
  三份同构代码收敛为一份。
