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

## 引擎快照字段（2026-09-09 增补，restore 对缺字段旧快照全部降级兼容）

- 酒馆：`revealedPool`（整局明牌池）、`announcedTitles`（已达成称号 key）、`legacyTitles`
  （旧格式快照恢复置真 → 称号系统整局静默，防重报/错发）、stats 增 `firstAction`。
- 骰子：`eliminationOrder`（出局顺序）、`announcedTitles` / `legacyTitles` 同上。
- 左轮牌堆常量 `buildRevolverDeck()` = 2 张（1 致命 1 空包）——恢复对局时旧快照里的
  4 张牌堆原样续用，不迁移。
- 交互层新增宿主无关能力：翻左轮两拍动画、称号即时播报/颁奖礼、明牌面板行、
  `pendingPenalties`（酒馆）/`penaltyQueue`（骰子）竞态惩罚队列——全部在 services 层，无宿主依赖。

## 睦子米（MutsumiBot）宿主落地纪要（2026-09-09）

- 运行形态：discord.py 2.x 单 cog `src/mutsumi_bot/cogs/liars_games.py`（双引擎+会话+View 一体，~4400 行）；
  命令为顶级 `/骗子酒馆` `/骗子骰子`（无神秘指令前缀，睦子米宿主惯例）；接线 = `bot.py` setup_hook 扩展列表。
- 5 根线映射：命令注册→`app_commands`；交互转发→View 对象持会话引用+闭包回调（无 customId 前缀，
  turnToken 校验保留在引擎 `apply` 内）；启动恢复→cog `on_ready` 快照恢复；成员失效→`on_member_remove`
  /`on_member_update` 监听；优雅关停→`cog_unload`（关会话+末次落盘）。
- 新增宿主能力（按本文档纪律登记）：
  - `LiarsGameRegistry`：酒馆+骰子跨游戏玩家/频道互斥锁（prbot 侧等价物由 gameManager 隐式承担）；
  - 快照统一为单文件 `DATA_DIR/liars_games_snapshot.json`（双 kind 共用一个 store，原子写 + 6h 过期丢弃，
    是「resume store 工厂化」理念在 Python 侧的进一步收敛）；
  - 改名锁为进程内 `RenameLockStore`：未到期锁随快照续命，`on_member_update` 强制改回 + 30s 到期恢复循环；
    审计日志理由按 kind 挂在锁上（`rename_reason`），持久化字段必须含它。
- 惩罚常量与 prbot 源一致（正常 4/8、认输/失格 3/6、自动禁言 4 分、结算窗 60s）；文案全部小睦人格特化。
- **键类型坑（JS→Python 移植通用）**：Python 玩家 id 是 int，快照经 JSON 往返后 dict 键腐蚀为 str——
  引擎 `from_dict` 必须经 `_int_keyed(data, players)` 归一化，且测试要走真实 `json.dumps/loads`
  （内存 roundtrip 测不出）。JS 侧 id 天然是字符串，无此问题。
- 规则文案修正双侧同步（「第一手不可质疑」→「桌面无牌无从质疑」，行为零改动）：
  prbot `5a4ddf6` / 睦子米 `e82e655e`。
- 真机冒烟门（本文档 checklist 第 6 步）：睦子米生产已部署 healthy + slash 已同步；
  起一局/重启续传/触发惩罚流三步仍待群内实测。
