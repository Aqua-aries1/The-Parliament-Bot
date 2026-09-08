/**
 * 三国杀会话层与交互服务（Node.js 原生版，规范简体中文）。
 * 负责：
 * - 房间生命周期管理、超时自动托管、断点续传恢复；
 * - 处理全部按钮与下拉交互（sgs: 前缀）；
 * - 纯异步锁保证对局状态机串行安全。
 */

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ComponentType,
} = require('discord.js');

const { Game, GameError, EquipmentSlot, GENERAL_LIST, ACTIVE_SKILLS, ACTIVE_SKILLS_BY_GENERAL } = require('../core/sgsEngine');
const { createSGSResumeStore } = require('../utils/sgsResumeStore');
const {
    formatEvents,
    renderMain,
    renderRecruit,
    renderPrivate,
    buildMainComponents,
    buildRecruitComponents,
} = require('./sgsPanels');

const store = createSGSResumeStore();
const activeSessions = new Map(); // guildId -> GameSession

const TURN_TIMEOUT_SEC = 180;
const RESPOND_TIMEOUT_SEC = 45;
const PENDING_TIMEOUT_SEC = 30;
const NULLIFY_TIMEOUT_SEC = 12;
const AUTO_PLAY_GRACE_SEC = 8;

class GameSession {
    constructor(client, game) {
        this.client = client;
        this.game = game;
        this.panel = null;
        this.timer = null;
        this.lastLog = [];
        this.lockQueue = Promise.resolve();
        this.released = false;
    }

    async withLock(action) {
        let release;
        const nextLock = new Promise(resolve => { release = resolve; });
        const currentLock = this.lockQueue;
        this.lockQueue = nextLock;

        await currentLock;
        try {
            return await action();
        } finally {
            release();
        }
    }

    // 在锁内执行游戏动作并兜底 GameError：返回 { ok, message }，
    // 防止状态推进/超时托管与用户浏览菜单竞态时抛错变成无反馈的未处理 rejection。
    async runGameAction(fn) {
        try {
            await this.withLock(fn);
            return { ok: true, message: '' };
        } catch (e) {
            const friendly = (e instanceof GameError) ? e.message : '操作失败（内部错误），请稍后在主面板重试。';
            if (!(e instanceof GameError)) console.error('[SGS] Game action error:', e);
            return { ok: false, message: friendly };
        }
    }

    recordEvents(events) {
        const nameOf = (pid) => {
            const p = this.game.players.find(x => x.userId === String(pid));
            return p ? p.name : '？';
        };
        const lines = formatEvents(events, nameOf, 20);
        this.lastLog.push(...lines);
        if (this.lastLog.length > 30) {
            this.lastLog = this.lastLog.slice(-30);
        }
    }

    armTimer() {
        this.cancelTimer();
        if (this.released || !this.game.started || this.game.finished) return;

        const armedToken = this.game.actionToken;
        const top = this.game.pendingTop;
        let delaySec = TURN_TIMEOUT_SEC;
        if (top) {
            if (top.kind === 'nullify') {
                // 全场无人持有【无懈可击】时走 3 秒过场，别让全桌陪等 12 秒。
                const anyNullify = this.game.players.some(p => p.alive && p.hand.some(c => c.name === '无懈可击'));
                delaySec = anyNullify ? NULLIFY_TIMEOUT_SEC : 3;
            } else if (top.kind === 'attack') {
                delaySec = RESPOND_TIMEOUT_SEC;
            } else {
                delaySec = PENDING_TIMEOUT_SEC;
            }
            // 已托管的响应者走短宽限，避免全桌被拖走整套长超时。
            if (top.deciderId !== '0') {
                const deciderP = this.game.players.find(p => p.userId === top.deciderId);
                if (deciderP && deciderP.autoPlay) delaySec = AUTO_PLAY_GRACE_SEC;
            }
        } else if (this.game.current && this.game.current.autoPlay) {
            // 托管玩家的出牌阶段只留 8 秒缓冲即自动结束回合。
            delaySec = AUTO_PLAY_GRACE_SEC;
        }

        this.timer = setTimeout(() => {
            void this._onTimeout(armedToken);
        }, delaySec * 1000);
    }

    cancelTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    async _onTimeout(armedToken) {
        if (this.released || this.game.actionToken !== armedToken) return;

        await this.withLock(async () => {
            if (this.released || this.game.actionToken !== armedToken) return;
            try {
                const top = this.game.pendingTop;
                if (top) {
                    if (top.deciderId !== '0') {
                        const targetP = this.game.players.find(p => p.userId === top.deciderId);
                        if (targetP) {
                            targetP.autoPlay = true;
                            this.lastLog.push(`⏱ **${targetP.name}** 响应超时，已自动进入托管模式。`);
                        }
                    }
                    const res = this.game.autoresolve(armedToken);
                    this.recordEvents(res.events);
                } else {
                    const cur = this.game.current;
                    if (!cur.autoPlay) {
                        // 玩家已手动接管（解除托管未换 token 的窗口期），不要抢结束回合。
                        this.armTimer();
                        return;
                    }
                    cur.autoPlay = true;
                    this.lastLog.push(`⏱ **${cur.name}** 出牌超时，已自动进入托管模式并结束回合。`);
                    const res = this.game.endTurn(cur.userId, armedToken);
                    this.recordEvents(res.events);
                }
                if (this.game.finished) {
                    store.remove(this.game.guildId);
                    this.cancelTimer();
                } else {
                    store.save(this.game.guildId, this.game.serialize());
                    this.armTimer();
                }
            } catch (e) {
                console.error('[SGS] Timeout action error:', e);
                // 兜底：处理失败也要保住计时链与快照，否则 pending 无人接手会全桌软锁。
                if (!this.game.finished) {
                    store.save(this.game.guildId, this.game.serialize());
                    this.armTimer();
                }
            }
        });

        await this.render();
    }

    async render() {
        if (this.released || !this.panel) return;
        try {
            if (this.game.finished) {
                await this.panel.edit({
                    embeds: [renderMain(this.game, this.lastLog)],
                    components: [],
                });
            } else if (this.game.started) {
                await this.panel.edit({
                    embeds: [renderMain(this.game, this.lastLog)],
                    components: buildMainComponents(this.game),
                });
            } else {
                await this.panel.edit({
                    embeds: [renderRecruit(this.game, `<@${this.game.ownerId}>`)],
                    components: buildRecruitComponents(this.game),
                });
            }
        } catch (err) {
            console.warn('[SGS] render edit failed:', err.message);
        }
    }

    async teardown(note = '房间已解散。') {
        this.released = true;
        this.cancelTimer();
        activeSessions.delete(this.game.guildId);
        store.remove(this.game.guildId);

        if (this.panel) {
            try {
                await this.panel.edit({ content: `🏯 ${note}`, embeds: [], components: [] });
            } catch (_) {}
            this.panel = null;
        }
    }
}

// ------------------------------------------------ 交互路由处理

async function handleSGSInteraction(interaction) {
    const customId = interaction.customId;
    if (!customId.startsWith('sgs:')) return;

    const parts = customId.split(':');
    // sgs:<scope>:<guildId>:<token>:<action>
    const scope = parts[1];
    const guildId = parts[2];
    const token = Number(parts[3]);
    const action = parts[4];

    const session = activeSessions.get(guildId);
    if (!session || session.released) {
        await interaction.reply({ content: '⌛ 当前三国杀对局面板已失效或已解散。', ephemeral: true });
        return;
    }

    if (scope === 'r') {
        await handleRecruitAction(session, interaction, action);
    } else if (scope === 'm') {
        await handleMainAction(session, interaction, action, token);
    }
}

async function handleRecruitAction(session, interaction, action) {
    const game = session.game;
    const userId = interaction.user.id;
    const userName = interaction.member?.displayName || interaction.user.username;

    if (action === 'join') {
        const r = await session.runGameAction(() => {
            const msg = game.join(userId, userName);
            store.save(game.guildId, game.serialize());
            return msg;
        });
        if (!r.ok) {
            await interaction.reply({ content: `❌ ${r.message}`, ephemeral: true });
            return;
        }
        await session.render();
        await interaction.reply({ content: `✓ ${r.message}`, ephemeral: true });
        return;
    }

    if (action === 'leave') {
        const r = await session.runGameAction(() => {
            const msg = game.leave(userId);
            store.save(game.guildId, game.serialize());
            return msg;
        });
        if (!r.ok) {
            await interaction.reply({ content: `❌ ${r.message}`, ephemeral: true });
            return;
        }
        await session.render();
        await interaction.reply({ content: `✓ ${r.message}`, ephemeral: true });
        return;
    }

    if (action === 'choose') {
        if (!game.players.some(p => p.userId === userId)) {
            await interaction.reply({ content: '请先点击「🪑 上桌」加入房间，再挑选武将。', ephemeral: true });
            return;
        }
        await showChooseGeneralModal(session, interaction);
        return;
    }

    if (action === 'rules') {
        await showRulesHelp(interaction);
        return;
    }

    if (action === 'start') {
        if (userId !== game.ownerId) {
            await interaction.reply({ content: '只有房主可以开始游戏。', ephemeral: true });
            return;
        }
        await interaction.deferReply({ ephemeral: true });
        const r = await session.runGameAction(() => {
            const res = game.start(userId);
            session.recordEvents(res.events);
            store.save(game.guildId, game.serialize());
            session.armTimer();
            return res;
        });
        if (!r.ok) {
            await interaction.followup({ content: `❌ ${r.message}`, ephemeral: true });
            return;
        }
        await session.render();
        await interaction.followup({ content: '🀄 游戏正式开始！请查看主面板并点击「🃏 我的信息」查阅专属手牌。', ephemeral: true });
        return;
    }

    if (action === 'dissolve') {
        if (userId !== game.ownerId) {
            await interaction.reply({ content: '只有房主可以解散房间。', ephemeral: true });
            return;
        }
        await interaction.deferReply({ ephemeral: true });
        await session.teardown('房主已解散房间。');
        await interaction.followup({ content: '房间已解散。', ephemeral: true });
        return;
    }
}

async function showChooseGeneralModal(session, interaction) {
    const game = session.game;
    const userId = interaction.user.id;
    const used = new Set(game.players.filter(p => p.general && p.userId !== userId).map(p => p.general));

    const shuWei = GENERAL_LIST.filter(g => ['蜀', '魏'].includes(g.faction) && !used.has(g.name));
    const wuQun = GENERAL_LIST.filter(g => ['吴', '群'].includes(g.faction) && !used.has(g.name));

    const rows = [];
    if (shuWei.length > 0) {
        const selSW = new StringSelectMenuBuilder()
            .setCustomId(`sgs_pick_sw_${Date.now()}`)
            .setPlaceholder('🏯 选择 蜀/魏 武将')
            .addOptions(shuWei.slice(0, 25).map(g => ({
                label: `【${g.name}】${g.faction}｜${g.skillName}`,
                description: g.description.slice(0, 50),
                value: g.name,
            })));
        rows.push(new ActionRowBuilder().addComponents(selSW));
    }

    if (wuQun.length > 0) {
        const selWQ = new StringSelectMenuBuilder()
            .setCustomId(`sgs_pick_wq_${Date.now()}`)
            .setPlaceholder('🌊 选择 吴/群 武将')
            .addOptions(wuQun.slice(0, 25).map(g => ({
                label: `【${g.name}】${g.faction}｜${g.skillName}`,
                description: g.description.slice(0, 50),
                value: g.name,
            })));
        rows.push(new ActionRowBuilder().addComponents(selWQ));
    }

    const reply = await interaction.reply({
        content: '请从下方下拉列表中挑选你的登场武将：',
        components: rows,
        ephemeral: true,
        fetchReply: true,
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120000,
    });

    collector.on('collect', async (selInter) => {
        const picked = selInter.values[0];
        const r = await session.runGameAction(() => {
            const msg = game.chooseGeneral(userId, picked);
            store.save(game.guildId, game.serialize());
            return msg;
        });
        await session.render();
        if (!r.ok) {
            // 武将可能刚被抢走：提示后保留菜单，让玩家继续挑别的武将。
            await selInter.update({ content: `❌ ${r.message}\n请继续从下方下拉列表中挑选你的登场武将：`, components: rows });
            return;
        }
        await selInter.update({ content: `✓ ${r.message}`, components: [] });
        collector.stop();
    });
}

async function showRulesHelp(interaction) {
    const select = new StringSelectMenuBuilder()
        .setCustomId(`sgs_rules_sel_${Date.now()}`)
        .setPlaceholder('📖 浏览规则与系统说明')
        .addOptions([
            { label: '身份与胜利目标', description: '主公/忠臣/反贼/内奸', value: 'roles' },
            { label: '卡牌与锦囊机制', description: '基本牌/锦囊/延时锦囊/无懈可击', value: 'cards' },
            { label: '武器与防具特效', description: '丈八/方天/青龙刀/麒麟弓/白银狮子等', value: 'equips' },
            { label: '濒死求桃与托管', description: '快跳救人、单次超时自动托管说明', value: 'flow' },
        ]);

    const row = new ActionRowBuilder().addComponents(select);
    const reply = await interaction.reply({
        content: '📜 **三国杀规则手册**\n请在下方下拉菜单中选择你想查阅的部分：',
        components: [row],
        ephemeral: true,
        fetchReply: true,
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 180000,
    });

    collector.on('collect', async (selInter) => {
        const val = selInter.values[0];
        let text = '';
        if (val === 'roles') {
            text = (
                '**👑 身份与胜利目标**\n' +
                '• **主公**：消灭所有反贼和内奸即可获胜。\n' +
                '• **忠臣**：不惜一切代价保护主公，与主公共享胜利。\n' +
                '• **反贼**：击杀主公即刻获得全盘胜利（击杀反贼者摸 3 张牌）。\n' +
                '• **内奸**：必须先消灭所有反贼和忠臣，最后在单挑中杀死主公独享胜利！'
            );
        } else if (val === 'cards') {
            text = (
                '**🎴 卡牌与锦囊对抗**\n' +
                '• **基本牌**：【杀】（出牌阶段限一次）、【闪】（回避攻击）、【桃】（回复体力或濒死救援）。\n' +
                '• **普通锦囊**：过河拆桥（弃目标一张牌）、顺手牵羊（拿目标一张牌，限距离 1）、决斗（轮流出【杀】，先不出者受伤）、无中生有（自己摸 2 张）、桃园结义（全场回复 1 点）、五谷丰登（每人各选 1 张）、南蛮入侵（全场需出【杀】否则受伤）、万箭齐发（全场需出【闪】否则受伤）。\n' +
                '• **⚡ 无懈可击抢断窗**：普通锦囊打出后，全场进入 12 秒抢断倒计时，任何人持有无懈可击均可抢按抵消！\n' +
                '• **延时锦囊**：乐不思蜀（跳过出牌）、兵粮寸断（跳过摸牌）、闪电（3点雷击伤害，自动移交下一个玩家判定）。'
            );
        } else if (val === 'equips') {
            text = (
                '**⚔️ 经典武器与防具特效**\n' +
                '• **距离**：相邻座位为 1；【进攻坐骑】-1、【防御坐骑】+1；武器决定你的攻击范围。\n' +
                '• **诸葛连弩**：出牌阶段使用【杀】无次数限制。\n' +
                '• **丈八蛇矛**：可以将任意 2 张手牌当作一张【杀】使用或打出。\n' +
                '• **青龙偃月刀**：使用的【杀】被【闪】抵消后，可立即追加打出一张【杀】！\n' +
                '• **方天画戟**：若使用的【杀】是手中最后一张手牌，可同时指定最多 3 名目标！\n' +
                '• **麒麟弓**：以【杀】造成伤害后，可射落并弃置目标的一匹坐骑牌。\n' +
                '• **八卦阵**：需要出【闪】时可进行判定，红色即视同打出【闪】。\n' +
                '• **仁王盾**：锁定技，黑色的【杀】对你完全无效。\n' +
                '• **白银狮子**：受到的单次伤害最多锁定为 1 点；失去装备时回复 1 点体力。'
            );
        } else {
            text = (
                '**⚡ 智能快跳与托管说明**\n' +
                '• **濒死求桃智能快跳**：全场手上没有【桃】的玩家直接静默跳过，无人有桃秒判阵亡，彻底告别死等。\n' +
                '• **单次超时严格托管**：玩家若单次操作超时未响应，自动标记为【托管中】（自动结束出牌、自动闪/桃防卫、自动弃牌）。\n' +
                '• **接管控制**：玩家随时点击主面板的【🙋 取消托管】即可重掌控制权。'
            );
        }
        await selInter.update({ content: text, components: [row] });
    });
}

// ------------------------------------------------ 对局主面板动作

// 无懈可击抢断流：从「⚡ 抢出无懈」或「🛡 响应」入口均可进入。
async function showNullifyFlow(session, interaction) {
    const game = session.game;
    const userId = interaction.user.id;
    const top = game.pendingTop;
    if (!top || top.kind !== 'nullify') {
        await interaction.reply({ content: '当前没有等待无懈可击抢断的锦囊。', ephemeral: true });
        return;
    }
    const player = game.players.find(p => p.userId === userId);
    if (!player || !player.alive) {
        await interaction.reply({ content: '阵亡角色不能参与抢断。', ephemeral: true });
        return;
    }
    const nullifies = player.hand.map((c, i) => ({ card: c, index: i })).filter(x => x.card.name === '无懈可击');
    if (!nullifies.length) {
        await interaction.reply({ content: '你手中没有【无懈可击】。', ephemeral: true });
        return;
    }

    const buttons = nullifies.map(x => (
        new ButtonBuilder()
            .setCustomId(`sgs_do_nullify_${x.index}`)
            .setLabel(`⚡ 抢出 ${x.card.short} 抵消`)
            .setStyle(ButtonStyle.Success)
    ));
    const row = new ActionRowBuilder().addComponents(buttons);
    // 给足上下文：谁对谁用了什么锦囊（手机上 ephemeral 弹层会盖住主面板的战场信息）。
    const trickUser = game.players.find(p => p.userId === String(top.data.user_id));
    const trickTarget = top.data.target_id ? game.players.find(p => p.userId === String(top.data.target_id)) : null;
    const trickLine = `${trickUser ? trickUser.name : '？'} 使用的【${top.data.trick_name}】${trickTarget ? `（目标：${trickTarget.name}）` : ''}`;
    const reply = await interaction.reply({
        content: `⚡ ${trickLine} 即将生效——要抢出【无懈可击】抵消吗？`,
        components: [row],
        ephemeral: true,
        fetchReply: true,
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 15000,
    });

    collector.on('collect', async (btnInter) => {
        const idx = Number(btnInter.customId.replace('sgs_do_nullify_', ''));
        await btnInter.deferUpdate();
        const r = await session.runGameAction(() => {
            const res = game.resolvePending(userId, { type: 'nullify', card_index: idx });
            session.recordEvents(res.events);
            store.save(game.guildId, game.serialize());
            session.armTimer();
            return res;
        });
        await session.render();
        if (!r.ok) {
            await interaction.editReply({ content: `❌ ${r.message}`, components: [] });
            collector.stop();
            return;
        }
        await interaction.editReply({ content: '✓ 已成功打出【无懈可击】！', components: [] });
        collector.stop();
    });
}

async function handleMainAction(session, interaction, action, token) {
    const game = session.game;
    const userId = interaction.user.id;

    if (!game.started || game.finished) {
        await interaction.reply({ content: '当前没有进行中的对局。', ephemeral: true });
        return;
    }

    const player = game.players.find(p => p.userId === userId);
    if (player && player.autoPlay) {
        await session.withLock(async () => {
            player.autoPlay = false;
            store.save(game.guildId, game.serialize());
            // 解除托管必须按非托管时限重排死线：托管期武装的 8 秒旧定时器
            // 不重排的话仍会到期，强制结束刚接管玩家的回合。
            session.armTimer();
        });
    }

    if (action === 'cancel_auto') {
        if (!player) {
            await interaction.reply({ content: '你不在本局游戏中。', ephemeral: true });
            return;
        }
        await session.withLock(async () => {
            player.autoPlay = false;
            store.save(game.guildId, game.serialize());
            session.armTimer(); // 同上：取消托管要重排死线
        });
        await session.render();
        await interaction.reply({ content: '✓ 已取消托管状态，恢复手动操控！', ephemeral: true });
        return;
    }

    if (action === 'rules') {
        // 主面板同样提供规则入口（招募面板原有的路由保留不动）。
        await showRulesHelp(interaction);
        return;
    }

    if (action === 'hand') {
        const embed = renderPrivate(game, userId);
        if (!embed) {
            await interaction.reply({ content: '你不在这个房间里或已阵亡。', ephemeral: true });
            return;
        }
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
    }

    if (action === 'nullify') {
        await showNullifyFlow(session, interaction);
        return;
    }

    if (action === 'respond') {
        const top = game.pendingTop;
        if (!top) {
            await interaction.reply({ content: '现在没有需要响应的结算——只有别人对你出【杀】或锦囊时才需要响应。', ephemeral: true });
            return;
        }
        // 无懈抢断窗与「响应」共用同一入口（抢断窗对全桌开放）。
        if (top.kind === 'nullify') {
            await showNullifyFlow(session, interaction);
            return;
        }
        if (top.deciderId !== userId) {
            const who = session.game.player(top.deciderId).name;
            await interaction.reply({ content: `现在轮到 ${who} 响应。`, ephemeral: true });
            return;
        }
        await showRespondModal(session, interaction);
        return;
    }

    if (action === 'play') {
        if (!player) {
            await interaction.reply({ content: '你不在这个房间里。', ephemeral: true });
            return;
        }
        if (game.pendingTop) {
            await interaction.reply({ content: '请先等待当前结算完成。', ephemeral: true });
            return;
        }
        if (game.current.userId !== userId) {
            await interaction.reply({ content: `现在是 ${game.current.name} 的回合。`, ephemeral: true });
            return;
        }
        if (player.skipPlay) {
            await interaction.reply({ content: '你受【乐不思蜀】影响，本回合不能出牌，请结束回合。', ephemeral: true });
            return;
        }
        await showPlayFlowModal(session, interaction);
        return;
    }

    if (action === 'skill') {
        if (!player) {
            await interaction.reply({ content: '你不在这个房间里。', ephemeral: true });
            return;
        }
        if (game.pendingTop) {
            await interaction.reply({ content: '请先等待当前结算完成。', ephemeral: true });
            return;
        }
        if (game.current.userId !== userId) {
            await interaction.reply({ content: `现在是 ${game.current.name} 的回合。`, ephemeral: true });
            return;
        }
        const specs = ACTIVE_SKILLS_BY_GENERAL[player.general] || [];
        if (!specs.length) {
            await interaction.reply({ content: '你的武将没有主动技能。', ephemeral: true });
            return;
        }
        await showSkillFlowModal(session, interaction, specs);
        return;
    }

    if (action === 'end') {
        await interaction.deferReply({ ephemeral: true });
        const r = await session.runGameAction(() => {
            const res = game.endTurn(userId, token);
            session.recordEvents(res.events);
            if (game.finished) {
                store.remove(game.guildId);
                session.cancelTimer();
            } else {
                store.save(game.guildId, game.serialize());
                session.armTimer();
            }
            return res;
        });
        await session.render();
        if (!r.ok) {
            await interaction.followup({ content: `❌ ${r.message}`, ephemeral: true });
            return;
        }
        await interaction.followup({ content: '✓ 回合已结束。', ephemeral: true });
        return;
    }
}

async function showRespondModal(session, interaction) {
    const game = session.game;
    const userId = interaction.user.id;
    const info = game.pendingOptions(userId);
    if (!info || !info.playable) {
        await interaction.reply({ content: '暂无可用响应。', ephemeral: true });
        return;
    }

    const kind = info.kind;
    const rows = [];

    if (kind === 'blade_pursue') {
        const buttons = info.cards.slice(0, 4).map(([c, n], i) => {
            const idx = game.player(userId).hand.indexOf(c);
            return new ButtonBuilder()
                .setCustomId(`sgs_resp_slash_${idx}`)
                .setLabel(`🗡️ 追击出 ${c.short}`)
                .setStyle(ButtonStyle.Danger);
        });
        buttons.push(new ButtonBuilder().setCustomId('sgs_resp_pass').setLabel('放弃追击').setStyle(ButtonStyle.Secondary));
        rows.push(new ActionRowBuilder().addComponents(buttons));
    } else if (kind === 'bow_mount') {
        const buttons = info.mounts.map(m => (
            new ButtonBuilder()
                .setCustomId(`sgs_resp_dismount_${m.slot}`)
                .setLabel(`🏹 拆落对方【${m.card.short}】`)
                .setStyle(ButtonStyle.Danger)
        ));
        buttons.push(new ButtonBuilder().setCustomId('sgs_resp_pass').setLabel('不拆除').setStyle(ButtonStyle.Secondary));
        rows.push(new ActionRowBuilder().addComponents(buttons));
    } else if (kind === 'dying') {
        const buttons = info.cards.slice(0, 4).map(x => (
            new ButtonBuilder()
                .setCustomId(`sgs_resp_peach_${x.index}`)
                .setLabel(`💊 打出 ${x.card.short} 救援`)
                .setStyle(ButtonStyle.Success)
        ));
        buttons.push(new ButtonBuilder().setCustomId('sgs_resp_decline').setLabel('放弃救援（TA 将阵亡）').setStyle(ButtonStyle.Danger));
        rows.push(new ActionRowBuilder().addComponents(buttons));
    } else if (kind === 'zone') {
        const options = info.choices.map((c, i) => ({
            label: c.label,
            value: String(i),
        }));
        const select = new StringSelectMenuBuilder()
            .setCustomId('sgs_resp_zone_sel')
            .setPlaceholder('选择操作区域')
            .addOptions(options);
        rows.push(new ActionRowBuilder().addComponents(select));
    } else if (kind === 'discard') {
        const player = game.player(userId);
        const options = player.hand.slice(0, 25).map((c, i) => ({
            label: c.short,
            value: String(i),
        }));
        const select = new StringSelectMenuBuilder()
            .setCustomId('sgs_resp_discard_sel')
            .setPlaceholder(`勾选要弃置的 ${info.need} 张手牌`)
            .setMinValues(info.need)
            .setMaxValues(info.need)
            .addOptions(options);
        rows.push(new ActionRowBuilder().addComponents(select));
    } else {
        const buttons = [];
        for (const [c, note] of info.cards.slice(0, 4)) {
            const idx = game.player(userId).hand.indexOf(c);
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`sgs_resp_card_${idx}`)
                    .setLabel(`打出 ${c.short}${note}`.slice(0, 80))
                    .setStyle(ButtonStyle.Success),
            );
        }
        if (kind === 'attack' && info.hasEightDiagram) {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId('sgs_resp_armor')
                    .setLabel('🛡 【八卦阵】判定')
                    .setStyle(ButtonStyle.Primary),
            );
        }
        buttons.push(
            new ButtonBuilder()
                .setCustomId('sgs_resp_pass')
                .setLabel(kind === 'attack' ? '放弃响应（将受到伤害）' : '放弃响应')
                .setStyle(ButtonStyle.Danger),
        );
        rows.push(new ActionRowBuilder().addComponents(buttons));
    }

    // 给足上下文：每种响应各自在对抗什么、不响应的后果是什么。
    let kindLine;
    if (kind === 'attack') {
        kindLine = '⏳ 你正被【杀】指定——出【闪】（或用【八卦阵】判定）闪避，不响应将受到伤害。';
    } else if (kind === 'aoe') {
        const top = game.pendingTop;
        kindLine = `⏳ 锦囊【${top?.data?.trick_name || 'AOE'}】波及你——出【${top?.data?.needed || ''}】自保，不响应将受到伤害。`;
    } else if (kind === 'duel') {
        kindLine = '⏳ 【决斗】进行中——出【杀】继续对抗，不出将受到伤害。';
    } else if (kind === 'dying') {
        kindLine = '⚠️ 有角色濒死——出【桃】救援，放弃则 TA 将阵亡。';
    } else if (kind === 'blade_pursue') {
        kindLine = '🗡️ 【青龙偃月刀】追击窗口——可追加出【杀】继续进攻，或放弃。';
    } else if (kind === 'bow_mount') {
        kindLine = '🏹 【麒麟弓】拆马窗口——可选择拆掉对方坐骑，或放弃。';
    } else if (kind === 'zone') {
        kindLine = '📦 请选择要获取/弃置的目标区域。';
    } else if (kind === 'discard') {
        kindLine = '🗑️ 请勾选要弃置的手牌（弃牌阶段或锦囊要求）。';
    } else {
        kindLine = '请作出响应：';
    }

    const reply = await interaction.reply({
        content: kindLine,
        components: rows,
        ephemeral: true,
        fetchReply: true,
    });

    const collector = reply.createMessageComponentCollector({ time: 60000 });

    collector.on('collect', async (cInter) => {
        let actionObj = null;
        if (cInter.customId.startsWith('sgs_resp_card_')) {
            const idx = Number(cInter.customId.replace('sgs_resp_card_', ''));
            actionObj = { type: kind === 'attack' ? 'dodge' : 'play', card_index: idx };
        } else if (cInter.customId === 'sgs_resp_armor') {
            actionObj = { type: 'armor' };
        } else if (cInter.customId === 'sgs_resp_pass') {
            actionObj = { type: 'pass' };
        } else if (cInter.customId.startsWith('sgs_resp_slash_')) {
            const idx = Number(cInter.customId.replace('sgs_resp_slash_', ''));
            actionObj = { type: 'slash', card_index: idx };
        } else if (cInter.customId.startsWith('sgs_resp_dismount_')) {
            const slot = cInter.customId.replace('sgs_resp_dismount_', '');
            actionObj = { type: 'dismount', slot };
        } else if (cInter.customId.startsWith('sgs_resp_peach_')) {
            const idx = Number(cInter.customId.replace('sgs_resp_peach_', ''));
            actionObj = { type: 'peach', card_index: idx };
        } else if (cInter.customId === 'sgs_resp_decline') {
            actionObj = { type: 'decline' };
        } else if (cInter.customId === 'sgs_resp_zone_sel') {
            const choice = info.choices[Number(cInter.values[0])];
            actionObj = { type: 'zone', ...choice.key };
        } else if (cInter.customId === 'sgs_resp_discard_sel') {
            const idxs = cInter.values.map(Number);
            actionObj = { type: 'discard', card_indexes: idxs };
        }

        if (actionObj) {
            await cInter.deferUpdate();
            const r = await session.runGameAction(() => {
                const res = game.resolvePending(userId, actionObj);
                session.recordEvents(res.events);
                if (game.finished) {
                    store.remove(game.guildId);
                    session.cancelTimer();
                } else {
                    store.save(game.guildId, game.serialize());
                    session.armTimer();
                }
                return res;
            });
            await session.render();
            if (!r.ok) {
                await interaction.editReply({ content: `❌ ${r.message}`, components: [] });
                collector.stop();
                return;
            }
            await interaction.editReply({ content: '✓ 已完成响应。', components: [] });
            collector.stop();
        }
    });
}

async function showPlayFlowModal(session, interaction) {
    const game = session.game;
    const userId = interaction.user.id;
    const player = game.player(userId);
    const weapon = player.equipment[EquipmentSlot.WEAPON];
    const hasZhangba = Boolean(weapon && weapon.name === '丈八蛇矛' && player.hand.length >= 2);

    const options = [];
    for (let i = 0; i < Math.min(player.hand.length, 25); i++) {
        const card = player.hand[i];
        const hint = game.playHint(userId, i);
        if (!hint.playable) continue;
        options.push({
            label: card.short,
            description: `${card.color}｜${card.cardType}`,
            value: String(i),
        });
    }

    if (!options.length && !hasZhangba) {
        await interaction.reply({ content: '当前没有可以打出的手牌。', ephemeral: true });
        return;
    }

    const rows = [];
    if (hasZhangba) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('sgs_play_zb_btn').setLabel('⚔️ 【丈八蛇矛】双牌当杀').setStyle(ButtonStyle.Primary),
        ));
    }

    if (options.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('sgs_play_pick_card').setPlaceholder('选择要打出的手牌').addOptions(options),
        ));
    }

    // 教学提示：被过滤的响应牌（闪/无懈）不在菜单里，新手常误以为手牌"坏了"。
    const hiddenCount = player.hand.length - options.length;
    const playNote = hiddenCount > 0
        ? '\n（【闪】【无懈可击】等响应牌不在此列出，轮到你响应时才会出现）'
        : '';

    const reply = await interaction.reply({
        content: `请选择出牌方式：${playNote}`,
        components: rows,
        ephemeral: true,
        fetchReply: true,
    });

    const collector = reply.createMessageComponentCollector({ time: 60000 });

    collector.on('collect', async (cInter) => {
        if (cInter.customId === 'sgs_play_zb_btn') {
            // 丈八模式
            const zbOpts = player.hand.slice(0, 25).map((c, i) => ({ label: c.short, value: String(i) }));
            const selZB = new StringSelectMenuBuilder()
                .setCustomId('sgs_play_zb_cards')
                .setPlaceholder('勾选 2 张手牌当【杀】')
                .setMinValues(2)
                .setMaxValues(2)
                .addOptions(zbOpts);

            await cInter.update({ content: '请勾选两张手牌：', components: [new ActionRowBuilder().addComponents(selZB)] });
            return;
        }

        if (cInter.customId === 'sgs_play_zb_cards') {
            const cIdxs = cInter.values.map(Number);
            const reach = game.attackRange(player);
            const targets = game._aliveOthers(player).filter(p => game.distance(player, p) <= reach);
            if (!targets.length) {
                await cInter.update({ content: '攻击范围内无合法目标。', components: [] });
                return;
            }
            const tOpts = targets.map(p => ({ label: `${p.name}（距离 ${game.distance(player, p)}）`, value: p.userId }));
            const selTarget = new StringSelectMenuBuilder()
                .setCustomId('sgs_play_zb_target')
                .setPlaceholder('选择【杀】的目标')
                .addOptions(tOpts);

            await cInter.update({
                content: `已选 2 张牌，请指定目标：`,
                components: [new ActionRowBuilder().addComponents(selTarget)],
            });

            const targetCollector = reply.createMessageComponentCollector({ time: 30000 });
            targetCollector.on('collect', async (tInter) => {
                if (tInter.customId === 'sgs_play_zb_target') {
                    const targetId = tInter.values[0];
                    await tInter.deferUpdate();
                    const r = await session.runGameAction(() => {
                        const res = game.playCard(userId, null, targetId, null, { cardIndexes: cIdxs });
                        session.recordEvents(res.events);
                        store.save(game.guildId, game.serialize());
                        session.armTimer();
                        return res;
                    });
                    await session.render();
                    if (!r.ok) {
                        await interaction.editReply({ content: `❌ ${r.message}`, components: [] });
                        targetCollector.stop();
                        collector.stop();
                        return;
                    }
                    await interaction.editReply({ content: '✓ 丈八出【杀】成功！', components: [] });
                    targetCollector.stop();
                    collector.stop();
                }
            });
            return;
        }

        if (cInter.customId === 'sgs_play_pick_card') {
            const cardIdx = Number(cInter.values[0]);
            const hint = game.playHint(userId, cardIdx);
            if (!hint.needsTarget || !hint.targets.length) {
                // 直接使用（桃/无中生有/装备/AOE等）
                await cInter.deferUpdate();
                const r = await session.runGameAction(() => {
                    const res = game.playCard(userId, cardIdx);
                    session.recordEvents(res.events);
                    store.save(game.guildId, game.serialize());
                    session.armTimer();
                    return res;
                });
                await session.render();
                if (!r.ok) {
                    await interaction.editReply({ content: `❌ ${r.message}`, components: [] });
                    collector.stop();
                    return;
                }
                await interaction.editReply({ content: '✓ 出牌成功！', components: [] });
                collector.stop();
                return;
            }

            // 需要目标
            const pool = game.players.filter(p => hint.targets.includes(p.userId));
            const tOpts = pool.map(p => ({ label: `${p.name}（距离 ${game.distance(player, p)}）`, value: p.userId }));
            const maxVal = hint.multiTarget ? Math.min(3, tOpts.length) : 1;
            const selT = new StringSelectMenuBuilder()
                .setCustomId('sgs_play_target_sel')
                .setPlaceholder(hint.multiTarget ? '选择最多 3 名目标' : '选择目标')
                .setMinValues(1)
                .setMaxValues(maxVal)
                .addOptions(tOpts);

            await cInter.update({
                content: `使用 ${player.hand[cardIdx].short}，请选择目标：`,
                components: [new ActionRowBuilder().addComponents(selT)],
            });

            const tCol = reply.createMessageComponentCollector({ time: 30000 });
            tCol.on('collect', async (tInter) => {
                if (tInter.customId === 'sgs_play_target_sel') {
                    const tids = tInter.values;
                    await tInter.deferUpdate();
                    const r = await session.runGameAction(() => {
                        const res = game.playCard(userId, cardIdx, tids.length === 1 ? tids[0] : null, null, {
                            targetIds: tids.length > 1 ? tids : null,
                        });
                        session.recordEvents(res.events);
                        store.save(game.guildId, game.serialize());
                        session.armTimer();
                        return res;
                    });
                    await session.render();
                    if (!r.ok) {
                        await interaction.editReply({ content: `❌ ${r.message}`, components: [] });
                        tCol.stop();
                        collector.stop();
                        return;
                    }
                    await interaction.editReply({ content: '✓ 出牌成功！', components: [] });
                    tCol.stop();
                    collector.stop();
                }
            });
        }
    });
}

async function showSkillFlowModal(session, interaction, specs) {
    const game = session.game;
    const userId = interaction.user.id;
    const player = game.player(userId);

    const options = specs.map(s => ({
        label: `【${s.skillId}】${s.description}`.slice(0, 100),
        value: s.skillId,
    }));

    const select = new StringSelectMenuBuilder()
        .setCustomId('sgs_skill_pick')
        .setPlaceholder('选择要发动的技能')
        .addOptions(options);

    const reply = await interaction.reply({
        content: '请选择主动技能：',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
        fetchReply: true,
    });

    const collector = reply.createMessageComponentCollector({ time: 60000 });

    collector.on('collect', async (sInter) => {
        const skillId = sInter.values[0];
        const spec = ACTIVE_SKILLS[skillId];
        if (!spec) {
            // 同一 reply 上还挂着选牌/选目标 collector，它们的值不是技能名，会进这里。
            await sInter.deferUpdate().catch(() => {});
            return;
        }

        if (!spec.needsCard && !spec.targets) {
            // 苦肉等直接发动
            await sInter.deferUpdate();
            const r = await session.runGameAction(() => {
                const res = game.activeSkill(userId, skillId);
                session.recordEvents(res.events);
                store.save(game.guildId, game.serialize());
                session.armTimer();
                return res;
            });
            await session.render();
            if (!r.ok) {
                await interaction.editReply({ content: `❌ ${r.message}`, components: [] });
                collector.stop();
                return;
            }
            await interaction.editReply({ content: `✓ 发动【${skillId}】成功！`, components: [] });
            collector.stop();
            return;
        }

        // 制衡等多选手牌
        if (spec.needsCard) {
            const hOpts = player.hand.slice(0, 25).map((c, i) => ({ label: c.short, value: String(i) }));
            const minVal = spec.cardCount === -1 ? 1 : spec.cardCount;
            const maxVal = spec.cardCount === -1 ? Math.max(1, hOpts.length) : spec.cardCount;

            const cardSelect = new StringSelectMenuBuilder()
                .setCustomId('sgs_skill_cards_sel')
                .setPlaceholder(spec.cardCount === -1 ? `勾选 1~${maxVal} 张手牌进行制衡` : `勾选 ${minVal} 张手牌`)
                .setMinValues(minVal)
                .setMaxValues(maxVal)
                .addOptions(hOpts);

            await sInter.update({
                content: `发动【${skillId}】，请选择手牌：`,
                components: [new ActionRowBuilder().addComponents(cardSelect)],
            });

            const cardCol = reply.createMessageComponentCollector({ time: 30000 });
            cardCol.on('collect', async (cInter) => {
                const cIdxs = cInter.values.map(Number);
                if (!spec.targets) {
                    await cInter.deferUpdate();
                    const r = await session.runGameAction(() => {
                        const res = game.activeSkill(userId, skillId, cIdxs);
                        session.recordEvents(res.events);
                        store.save(game.guildId, game.serialize());
                        session.armTimer();
                        return res;
                    });
                    await session.render();
                    if (!r.ok) {
                        await interaction.editReply({ content: `❌ ${r.message}`, components: [] });
                        cardCol.stop();
                        collector.stop();
                        return;
                    }
                    await interaction.editReply({ content: `✓ 发动【${skillId}】成功！`, components: [] });
                    cardCol.stop();
                    collector.stop();
                    return;
                }

                // 需要目标（离间等）
                const targets = game._aliveOthers(player);
                const tOpts = targets.map(p => ({ label: p.name, value: p.userId }));
                const tSel = new StringSelectMenuBuilder()
                    .setCustomId('sgs_skill_target_sel')
                    .setPlaceholder(`选择 ${spec.targets} 名目标`)
                    .setMinValues(spec.targets)
                    .setMaxValues(spec.targets)
                    .addOptions(tOpts);

                await cInter.update({
                    content: `请指定 ${spec.targets} 名目标：`,
                    components: [new ActionRowBuilder().addComponents(tSel)],
                });

                const tCol = reply.createMessageComponentCollector({ time: 30000 });
                tCol.on('collect', async (tInter) => {
                    const tids = tInter.values;
                    await tInter.deferUpdate();
                    const r = await session.runGameAction(() => {
                        const res = game.activeSkill(userId, skillId, cIdxs, tids);
                        session.recordEvents(res.events);
                        store.save(game.guildId, game.serialize());
                        session.armTimer();
                        return res;
                    });
                    await session.render();
                    if (!r.ok) {
                        await interaction.editReply({ content: `❌ ${r.message}`, components: [] });
                    } else {
                        await interaction.editReply({ content: `✓ 发动【${skillId}】成功！`, components: [] });
                    }
                    tCol.stop();
                    cardCol.stop();
                    collector.stop();
                });
            });
            return;
        }

        // 纯目标技能（离间等无弃牌分支如果存在）
        if (spec.targets) {
            const targets = game._aliveOthers(player);
            const tOpts = targets.map(p => ({ label: p.name, value: p.userId }));
            const tSel = new StringSelectMenuBuilder()
                .setCustomId('sgs_skill_target_only_sel')
                .setPlaceholder(`选择 ${spec.targets} 名目标`)
                .setMinValues(spec.targets)
                .setMaxValues(spec.targets)
                .addOptions(tOpts);

            await sInter.update({
                content: `请指定 ${spec.targets} 名目标：`,
                components: [new ActionRowBuilder().addComponents(tSel)],
            });

            const tCol = reply.createMessageComponentCollector({ time: 30000 });
            tCol.on('collect', async (tInter) => {
                const tids = tInter.values;
                await tInter.deferUpdate();
                const r = await session.runGameAction(() => {
                    const res = game.activeSkill(userId, skillId, [], tids);
                    session.recordEvents(res.events);
                    store.save(game.guildId, game.serialize());
                    session.armTimer();
                    return res;
                });
                await session.render();
                if (!r.ok) {
                    await interaction.editReply({ content: `❌ ${r.message}`, components: [] });
                } else {
                    await interaction.editReply({ content: `✓ 发动【${skillId}】成功！`, components: [] });
                }
                tCol.stop();
                collector.stop();
            });
        }
    });
}

// ------------------------------------------------ 顶级创建/置顶入口

async function launchOrRefreshSGS(interaction) {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    const userId = interaction.user.id;
    const userName = interaction.member?.displayName || interaction.user.username;

    let session = activeSessions.get(guildId);

    // 场景 1：如果当前频道已有活跃房间，删除旧消息并在当前频道重新发送并置顶
    if (session && !session.released) {
        await interaction.deferReply({ ephemeral: true });
        await session.withLock(async () => {
            if (session.panel) {
                try { await session.panel.delete(); } catch (_) {}
                session.panel = null;
            }
            if (session.game.started) {
                session.panel = await interaction.channel.send({
                    embeds: [renderMain(session.game, session.lastLog)],
                    components: buildMainComponents(session.game),
                });
            } else {
                session.panel = await interaction.channel.send({
                    embeds: [renderRecruit(session.game, `<@${session.game.ownerId}>`)],
                    components: buildRecruitComponents(session.game),
                });
            }
            store.save(guildId, session.game.serialize());
        });
        await interaction.followup({ content: '✓ 已在当前频道刷新并置顶三国杀交互面板！', ephemeral: true });
        return;
    }

    // 场景 2：创建全新房间
    await interaction.deferReply();
    const game = new Game({ guildId, channelId, ownerId: userId, ownerName: userName });
    session = new GameSession(interaction.client, game);
    activeSessions.set(guildId, session);

    session.panel = await interaction.channel.send({
        embeds: [renderRecruit(game, `<@${userId}>`)],
        components: buildRecruitComponents(game),
    });
    store.save(guildId, game.serialize());

    await interaction.followup({
        content: `🏯 ${interaction.user} 开启了三国杀房间！\n👉 请点击下方交互面板中的「🪑 上桌」与「🎭 挑选武将」（3～8人开局）。`,
    });
}

async function restoreAllSGSGames(client) {
    const list = await store.list();
    let count = 0;
    for (const [guildId, data] of Object.entries(list)) {
        try {
            if (!data || data.finished) {
                store.remove(guildId); // 已结束的对局快照直接清理，不占用房位
                continue;
            }
            const game = Game.restore(data);
            const session = new GameSession(client, game);
            const channel = await client.channels.fetch(game.channelId).catch(() => null);
            if (channel) {
                // 尝试查找历史消息（仅认标题带「三国杀」的面板，避免误拿其它游戏面板）
                const messages = await channel.messages.fetch({ limit: 15 }).catch(() => null);
                if (messages) {
                    const botMsg = messages.find(m => m.author.id === client.user.id
                        && m.embeds.length > 0
                        && typeof m.embeds[0]?.title === 'string'
                        && m.embeds[0].title.includes('三国杀'));
                    if (botMsg) session.panel = botMsg;
                }
            }
            activeSessions.set(guildId, session);
            if (!game.finished && game.started) {
                session.armTimer();
            }
            count++;
        } catch (e) {
            console.error(`[SGS] 恢复公会 ${guildId} 房间失败:`, e);
        }
    }
    if (count > 0) {
        console.log(`[SGS] 成功恢复 ${count} 场三国杀对局。`);
    }
    return count;
}

module.exports = {
    handleSGSInteraction,
    launchOrRefreshSGS,
    restoreAllSGSGames,
};
