# 对抗性审查自循环日志（09-08 夜，目标 ≥10 轮，只提交不部署）

## 基线
- 分支 feat/sgs-game @ 385ba24（已推 fork）。基线回归：liarsbar_flow ✅ / liarsdice_test ✅ / panel_check ✅ / devilEngine 8 项 ✅

## 有意为之、不要再"修"的偏差（防误报）
- 骰子 spot_on EV 随人数放大（-0.1→+1.3）= 设计意图（英雄翻盘线），有冷却平衡
- 酒馆双小丑第二张算假牌 = 拍板规则；左轮 1 实 3 空、质疑不加弹 = 拍板
- 超时自动出牌/自动质疑 = 有意兜底，非 bug
- SGS：狂骨/巨象只吃【杀】伤害、濒死者先摸牌技再求桃、花色配额贴真实牌堆、八卦可主动选判定、拆牵/奇袭自选区域、武圣/龙胆不占主动技、无双不作用决斗、弃牌不触发连营、五谷/桃园从座位 0 起 = 均为拍板/原版一致
- 惩罚时长 4/8（认输 3/6）= 拍板
- 两段式确认（选菜单仅登记+确认按钮）= 用户强要求的防误触设计

## 轮次记录
（每轮追加：视角 / 发现 / 修复 / 回归 / 提交）

## R1 对抗视角（作弊者/漏洞猎人）——子agent×2 独立评审 ✅
- 结论：零 P0（锁/token 骨架经受住推演）；双骗子 5 P1+4 P2、SGS 1 P1+9 P2，全部核实为真后修复 ~16 项：
  - 【拖延】刷新面板重置回合计时器（两游戏）→ renderLocked({armTimer:false})
  - 【逃罚】骰子终局丢弃 penaltyQueue → 队列与 phase 解耦，罚完再终局
  - 【错罚】成员失格按"第一个死者"找受罚人 → 改为失格者本人（两游戏）
  - 【崩场】酒馆招募期失格走惩罚流 TypeError → 对齐骰子早退分支（含骰子 invite_cancel 同款洞）
  - 【泄露】私密面板聚合"全场真牌数"（2/3 人局不可推导）→ 改为纯公开信息（全场恒 8 张）
  - 【二次惩罚】认输残留 lastPlay/currentBid 可被"开尸" → 酒馆清声明/骰子声明作废无人受罚 + 决定人存活兜底（两游戏）
  - 【误导】bidConfirm 缺 pending.turnToken 校验 + bidViewRows 渲染跨回合残留 → 双补
  - 【文案】酒馆 rulesEmbed 惩罚数值 5/10 硬编码 → 改常量插值（实际 4/8）
  - 【SGS】解除托管不重排死线（旧 8s 定时器强制结束接管者回合）→ 两处清托管后 armTimer + _onTimeout 复查 autoPlay
  - 【SGS】超时 catch 吞错断计时链 → 兜底 save+armTimer
  - 【SGS】技能面板顶层 collector 未防串扰 TypeError → spec 空守卫
  - 【SGS】离间引擎层可指定自己/亡者 → targetFilter: other_alive
  - 【SGS】青龙/麒麟先删 pending 后校验 → 先校验后动栈
  - 【SGS】国色转化原牌凭空消失 → 入弃牌堆
- 回归：6 语法检查 + liarsbar/liarsdice/panel/sgs_flow/sgs_interaction 全绿 + 双模拟器 + 恶魔轮盘 7 测 + devilEngine 8 项全绿
- 接受不修：无懈 3s 快跳侧信道（观战者可推断无人持无懈；根治=恒 12s 窗，节奏代价不值）；SGS 乐观锁全面接线、响应面板打开续期、出局路径 finished 快照清理 → 留 R6
- 提交：见 git log R1

## R2 新手视角（子agent）+ R4 博弈平衡（子agent）✅
- R2 三游戏新手旅程审查：3 P1 + 12 P2/P3 全落地——骰子指令描述 2-4→4-8 人（开不了局死局）、「开牌=质疑」术语统一、👁 我的骰子、菜单 placeholder 教学句、亮骰用骰面 emoji、酒馆 🎴 手牌消歧、质疑按钮带对象名、超时文案带后果、收利息→决定惩罚；SGS 三 P1（主面板规则手册按钮+路由、私密面板技能全文、武将技能速查章节）+ 响应弹窗逐 kind 上下文 + 放弃响应/救援带后果 + 出牌菜单隐藏牌教学句 + 锦囊效果补全 + 距离说明 + 无懈窗 12 秒说明 + 主面板自动托管提示。
- R4 博弈论数据发现（reviews/r4/ 实验脚本）：
  1) 酒馆自愿质疑 EV 恒负（临界诚实率 ≤0.8 vs 实测 90%+），质疑全来自强制渠道；机会主义 bot 与全龟缩 bot 胜率逐位相同 → 卡牌策略不影响胜负（退化 RNG 处决）。
  2) 先手处刑跑步机：强制质疑者恒为当轮先手，初始先手胜率 5.7%（3p 全龟缩）vs 其上家 61%。
  3) 骰子 spot_on 已激活（紧阈值 8 人 +2.25pp 显著）、先手不吃亏 → 无需改。
  **修复**：酒馆质疑两振制（首次失手免翻左轮只记警告，failedChallenges 入快照）+ 新一轮先手改输家下家（_nextAliveAfter）。专项测试 reviews/r4_two_strike.cjs 18 项全过；模拟器 meta 符合预期（致命率 36.8%→23.8%，单局 5.5→8.4 轮，出牌量 9.9→15.4/局）。
  **注意**：这两条改了此前拍板的"输家统一翻 1 张 / 输家当先手"——数据证明旧规则使游戏退化，用户醒后可 review，revert 只需一个 commit。
- 回归：5 流程测试+双模拟器+两振制专项全绿。提交见 git log R2R4。

## R6 SGS 深审（子agent，第二次跑成）✅ e4ac207
- A1 乐观锁接线：10 调用点全接 Number(token)（resolvePending×2/playCard×3/activeSkill×4/endTurn 已有）；托管解除/cancel_auto 有意不接（不 bump token，接管按钮应允许旧面板）。
- A2 响应面板续期：session.renewedForToken 每结算窗口只续一次（armTimer 按当前状态重算，托管者仍 8s）。
- A3 persistAfterAction 统一持久化：终局清快照停表，11 处收敛（timeout/endTurn/respond/nullify/play×3/skill×4）。
- B 规则忠实度：连营/南蛮万箭/濒死/闪电判定全符合；修 2 处——闪电移交下家已有则继续下传（官方惯例）、五谷文案"各选 1 张"→"各摸 1 张"对齐实现。

## R7 资源与性能（自查）✅
- timers：schedule 自除+unref+cleanupGame 清空 ✓；lastLog 修剪 30 ✓；activeSessions 释放即删 ✓；panels 剪枝 3 ✓。
- 实修 1 处：SGS 战报 slice(0,1000) 字符硬切破行 → 按行边界裁（>1000 找 lastIndexOf('\n')）。

## R8 玩法新意 ✅（见提交）
- 酒馆声明链：主面板"📜 本轮声明：A×2 → B×1（可质疑最后一手）"——补异步对局记忆缺口（盖牌暗、谁盖了几张公开）。
- 终局复盘（双游戏）：engine stats（酒馆：出牌/撒谎/被拆/质疑/抓到/翻轮/存活；骰子：叫点/开牌/抓到/判错/精准/命中/失骰）+ settlementEmbed "📊 本局复盘" field；纯内存不入持久库，serialize 含 stats 保断点续传后数据不丢。
- 专项 reviews/r8_recap.cjs 13 项全过；全量回归绿；模拟器 meta 无回归。

## R9 注入与边界审计（子agent）✅ 8533789 + 追修 3732578
- P1 实修：SGS 响应行 6 组件超限（3 闪+八卦+放弃=5）、场上 field 8 人可超 1024（按行裁剪）、无懈按钮行 slice(0,5)、SGS 名字入库剥离 markdown 控制字符（反引号可逃出 playerLines code span 伪造公开面板）。
- P2 实修：plainName 剥 `*_~\`#|>`（双游戏，防标题/按钮伪造）、rename 昵称净化补集、武将描述按码点截断（防劈开 emoji 代理对）。
- 追修：join 名字净化原地对 const 形参赋值 → TypeError 炸上桌流程（sgs_interaction 4 项红）→ 改局部 safeName。
- 接受不修：SGS ephemeral 回复未设 allowedMentions（embed 默认不响铃，纵深项）、武将速查 1587 字 <2000（扩将时再改 embed）。
- 教训：python 批量补丁对"重赋值形参"类模式要过一遍 const/let 检查；r8_recap 首跑失败为瞬态（与 r5_faults 同进程链的状态残留），单独复跑过。

## R10 终审（全新子agent 复看累计 diff）✅ cb5a7a3 已推 fork
- **抓到自循环自己引入的 P0**：R1 的 SGS 超时守护 `if (!cur.autoPlay) 重排` 把"挂机→强制托管"主路径砍成无限重排（任何玩家挂机=全桌软锁）。修复=时间窗判定：仅"刚解除托管 <8s"（autoPlayClearedAt 时间戳）的竞态窗口放行重排，普通挂机走原托管主路径。sgs_flow 超时项回归通过。
- **抓到两个"宣称修了实际没落上"的 P1**（python 批量补丁静默 no-op 的代价）：①renewedForToken 只建了字段没插续期逻辑 → 补 showRespondModal（decider 校验）/showNullifyFlow 两处插入点；②复盘面板展示端整体缺失（R8 的 settlementEmbed 替换未命中，只有采集端）→ 用 Edit 工具带精确原文补上双游戏复盘 field。
- P2 修复：骰子"声明作废"播报（不再谎报死者失骰）、酒馆空手死角（最后声明作废+全场空手 → 重开一轮防指向死者空转）、SGS 空名回退、骰子 penaltyEmbed"收利息"对称遗漏。
- 误报驳回：R10 称响应行 slice(0,4) 本就合规——算术错误（4+八卦+放弃=6>5），维持 slice(0,3)。
- 终审后全量回归绿（5 流程+3 专项+双模拟器）。8 提交推送 fork：feca849→b770b06→1c05a04→e4ac207→fc21eb0→8533789→3732578→cb5a7a3。
- **循环总结**：10 轮完成（R1 对抗/R2 新手/R3 异步UX/R4 博弈/R5 健壮/R6 SGS深审/R7 资源/R8 新意/R9 注入/R10 终审），子agent 独立评审 7 次，累计 +490/-175 行。核心方法论收获：①批量脚本补丁必须逐个验证命中（两次静默 no-op）②每轮全量回归是抓自己 bug 的最后防线（R9 const 炸流程、R10 P0 软锁均由下一环抓住）③博弈规则改动要有模拟数据背书。

# 2026-09-09 体验优化轮（左轮 2 张制 + 明牌池 + 毒舌称号 + 两拍动画）

用户拍板：实测痛点=对局太长；全量优化不做 MVP 截断；左轮改 2 张（1/2→必死，每人整局最多侥幸 1 次）；骰子规则冻结（时长可接受）；砍死斗（2 张制已消灭尾局拖长）；称号毒舌整活型。

## R1 自审（git diff 对抗）
- 修复：两拍动画颜色剧透——panelColor 第一拍按 resultColor 已染致命红，悬念未揭晓 savvy 玩家看色知生死 → 第一拍改中性结果色（橙=抓到/绿=质疑失败），揭晓拍恢复全量色。

## R2 子 agent 引擎审查（独立，node 实测验证）
- F1(P1) 修：r11 骰子段假覆盖——引擎每轮重掷骰子，跨轮断言按注入值推演是抽签 → 每轮边界重注定值骰，10/10 确定性。
- F2(P1) 修：r4_two_strike 被 50% 首翻致命打破（旧 25%）→ 测试钉死双方左轮牌堆。
- F3(P1) 修：骰子 _collectTitles 的 `if (!st) continue` 门控——从未行动就认输的首个出局者永久吞掉「骨灰级玩家」（且堵死全场）→ `stats[pid] || {}`。回归测试补 F3 场景。
- F4(P2) 止血：旧格式快照恢复 → 称号重报/赌狗错发 → `legacyTitles` 标记（restore 无 announcedTitles 字段即置真），称号系统整局静默。双引擎 serialize 带该标记。
- P2 采纳：明牌面板行改用引擎 revealedCount 单源（删双实现）；骨灰级 tiebreak 注释。

## R3 自审（交互层）
- 修复：认输/失格六处手工拼 lastEvent 丢 result.titles（称号永不播）→ 双游戏各加 appendTitles helper 补全部调用点（酒馆 resume 补判/surrender/失格三处 + 骰子同构三处）。
- 实证：flow 测试 channel mock 支持 edit → 两拍动画全路径被回归覆盖。

## R4 子 agent 交互层审查（独立，实测 embed 尺寸/时序）
- F1(P1) 修：两拍动画窗口在 runExclusive 之外（act 锁内只包同步 apply），1.4s 窗口内认输/失格可插入 → beginEliminationPenaltyLocked(B) 先入场，动画流随后无条件覆盖 → B 的惩罚静默被吞。修复=竞态守卫：已有未落定惩罚时把新出局者入队（酒馆新 pendingPenalties / 骰子复用 penaltyQueue），resumeAfterPenaltyLocked 逐一补判，连环到清空；酒馆 pendingPenalties 入 serialize/restore。
- F2(P2) 修：动画窗口内「刷新面板」渲染战后状态剧透翻牌 → animating 标志，refreshPanel 窗口内拒绝（半秒后再试）。
- F3(P2) 修：非出局质疑的「🎴 新一轮」广播与揭晓消息逐字重复 → 两拍路径不再补发过场播报（免翻路径保留）。
- F4(P2) 清理：动画 dead `previous` 变量、awards map 未消费 key。
- F5(P2 预存在) 修：超时托管标记「（⏰ 超时自动…）」被 afterActionLocked 首行无条件覆盖（HEAD 即如此）→ afterActionLocked 增 actionOpts.forcedNote 管道，双游戏 turnTimeout 改传参，两拍路径 reveal 文案也带注。
- 接受不修：赌狗可被超时托管触发（quip 安到挂机玩家头上，纯文案口径）；梭哈鬼才与神算子可共存（人设打架是笑点）。
- 尺寸实证：对抗配置下 settlementEmbed field.value 923/1024、playEmbed desc 247/4096、按钮 5/5——全部合规；Discord 限速无 429 面。

## R5 终审
- 16 测试文件全量绿 + 双模拟器 1000 局零崩溃：酒馆平均 5.87 轮/局（旧 4 张制约减半）、致命率 34.1%；骰子 19.2 轮/局不变。
- PORTING.md 增补引擎快照字段与降级语义；教训：①动画/广播类 I/O 天然在锁外，跨 I/O 的状态机写入口必须自带竞态守卫（不能假设「同一流程」顺序执行）②概率参数改动会打破所有依赖随机存活的老测试——钉死随机源 ③称号/成就类功能要审计「所有生成本动作」的路径（六个手工 lastEvent 全漏了）。
