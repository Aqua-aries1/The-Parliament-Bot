/**
 * 骗子酒馆交互层（2-4 人公开招募，Liar's Deck 模式）。
 *
 * 面板/按钮/流程/文案：
 *   - 招募面板：🪑 上桌 / 🎬 发起人开局（≥2 人）/ 🛑 发起人取消 / 📖 游戏规则
 *   - 主面板：桌面点数 + 玩家区块（手牌数/左轮余量）+ 出牌选择菜单 + 🤥 质疑
 *             + 🃏 看我的牌（仅自己可见）+ 📖 游戏规则
 *   - 播报面板：出牌（张数醒目）/ 开牌结果 / 左轮翻牌 / 新一轮发牌
 *   - 🔨 出局惩罚：每个出局者当场结算一次（抓到的人/顺位存活者/终局时的胜者选
 *             🔇 禁言 / ✏️ 改名，60s 自动禁言）；全部出局者受罚后，唯一幸存者获胜
 *
 * 引擎状态机走 core/liarsBarEngine；走 mystery 骨架：gameManager 锁、
 * custom-id 路由前缀 mystery_liars_bar_、mysteryNicknameLock 昵称锁。
 * 惩罚流/断点续传/软兜底等均对齐 devilRouletteGame 的成熟模式。
 */

const { randomUUID } = require('node:crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const gameManager = require('./mysteryGameManager');
const nicknameLock = require('./mysteryNicknameLock');
const { ORDINARY_LOCK_TYPES } = require('./mysteryNicknameLockService');
const resumeStore = require('../utils/liarsBarResumeStore');
const {
    LiarsBarState,
    InvalidAction,
    defaultRng,
    CARD_LABELS,
    HAND_SIZE,
    MAX_PLAY_CARDS,
} = require('../core/liarsBarEngine');

// ── 常量 ────────────────────────────────────────────────────────────────────

const RECRUIT_SECONDS = 120; // 招募面板等待时长
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const TURN_SECONDS = 60;
const GRACE_SECONDS = 2;
const EPHEMERAL_TTL_MS = (TURN_SECONDS + GRACE_SECONDS + 30) * 1000; // 私密面板存活覆盖整个回合（含思考时间）
const PANEL_HISTORY_LIMIT = 3;
const ITEM_HELP_LABEL = '📖 游戏规则';
const PENALTY_MUTE_MINUTES = 4;
const PENALTY_RENAME_MINUTES = 8;
const PENALTY_AUTO_MUTE_MINUTES = 4;
const PENALTY_SETTLEMENT_SECONDS = 60;
const SURRENDER_MUTE_MINUTES = 3;
const SURRENDER_RENAME_MINUTES = 6;
const PENALTY_NICKNAME = '🤥 骗子酒馆输家';
const PENALTY_MUTE_REASON = '骗子酒馆：出局惩罚';
const PENALTY_RENAME_APPLY_REASON = '骗子酒馆：出局强制改名';
const PENALTY_RENAME_RESTORE_REASON = '骗子酒馆：改名惩罚到期，恢复原昵称';
const PENALTY_RENAME_ENFORCE_REASON = '骗子酒馆：出局强制改名';
const RENAME_LOCK_TYPE = 'liars_bar_rename';
const RENAME_MODAL_PREFIX = 'mystery_liars_bar_rename_modal';

const RANK_EMOJI = {}; // K/Q/A 不再配 emoji（与牌面统一纯文字），小丑在 CARD_LABELS 自带 🃏

// 风味文案：酒馆调子，短、冷、带点嘲弄。
const FLAVOR = {
    play: [
        '牌落桌面，没人看清是什么。',
        '它把牌推了出去，脸不红心不跳。',
        '桌面又多了几张背朝上的纸。',
        '一声轻响，牌进了堆里。',
        '它说这些都是真的。也许吧。',
    ],
    challenge: [
        '有人把酒杯放下了。',
        '空气突然安静。',
        '「骗子。」——这个词砸在桌面上。',
        '牌桌上的礼貌到此为止。',
        '它伸手按住了那几张牌。',
    ],
    liar_caught: [
        '谎言被摊开在灯下。',
        '牌翻过来了，说谎的人低下头。',
        '纸包不住火，牌包不住谎。',
        '它撒谎了，全桌都看见了。',
    ],
    wrong_call: [
        '牌翻过来——全是真的。',
        '质疑的人脸色变了。',
        '它没撒谎。倒霉的是不信的人。',
        '真相有时比谎言更伤人。',
    ],
    blank: [
        '……咔嗒。空包。',
        '枪响了，但只是吓了一跳。',
        '命运今天没打算收人。',
        '弹巢空转了一格。',
        '它还坐着。下一次未必。',
    ],
    lethal: [
        '砰。椅子空了。',
        '这一次，枪没有留情。',
        '它输掉的不是牌，是座位。',
        '酒保擦了擦杯子，像什么都没发生。',
        '门帘晃了一下，少了一个人的影子。',
    ],
    new_round: [
        '新一轮，牌重新发。',
        '酒保收走旧牌，摆上新的一副。',
        '桌面清空了，谎言重新开始。',
        '还在坐着的人，运气还没用完。',
    ],
    game_end: [
        '最后坐着的人拿走了酒钱。',
        '灯灭了，酒馆只剩一个人。',
        '它喝完了那杯酒，慢慢起身。',
        '桌子还在，谎言结束了。',
    ],
    surrender: [
        '它放下牌，离开了酒馆。',
        '不玩了。这也是一种诚实。',
        '椅子推开的声音，比枪响体面。',
        '它输不起，但走得掉。',
    ],
};

const EXPIRED_MESSAGE = '这局已经结束了。';
const NOT_YOUR_TURN_MESSAGE = '现在还没轮到你。';
const ACT_FAILED_MESSAGE = '操作失败，请重试或刷新面板。';

// ── 基础工具 ──────────────────────────────────────────────────────────────────

function logDiscordFailure(game, action, error, userId = 'system') {
    console.error(
        `[MysteryLiarsBar] Discord API 失败 (guild=${game?.guildId || 'unknown'}, game=${game?.id || 'unknown'}, user=${userId}, action=${action}):`,
        error
    );
}

function mention(userId) {
    if (userId == null) return '（无人）';
    return `<@${userId}>`;
}

function pickRandom(arr) {
    if (!arr || !arr.length) return '';
    return arr[Math.floor(Math.random() * arr.length)];
}

function flavor(kind) {
    return pickRandom(FLAVOR[kind] || []);
}

function cardLabel(card) {
    return CARD_LABELS[card] || card;
}

function rankLabel(rank) {
    if (rank == null) return '—';
    return `${RANK_EMOJI[rank] || ''} ${rank}`;
}

// ── 网络健壮性工具（对齐 devilRouletteGame） ─────────────────────────────────

async function deferComponent(interaction, { ephemeral }) {
    if (!interaction || interaction.replied || interaction.deferred) return true;
    try {
        if (ephemeral) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            interaction._ephemeralDeferred = true;
        } else {
            await interaction.deferUpdate();
        }
        return true;
    } catch (error) {
        logDiscordFailure(null, 'defer-component', error, interaction.user?.id);
        return false;
    }
}

function scheduleEphemeralDelete(message, delayMs = EPHEMERAL_TTL_MS) {
    if (!message || typeof message.delete !== 'function') return;
    const t = setTimeout(() => {
        message.delete().catch(() => {});
    }, delayMs);
    t.unref?.();
}

async function sendEphemeral(interaction, payload) {
    if (!interaction) return false;
    try {
        let message = null;
        if (interaction._ephemeralDeferred && typeof interaction.editReply === 'function') {
            await interaction.editReply(payload);
            message = await interaction.fetchReply?.() || null;
        } else if ((interaction.deferred || interaction.replied) && typeof interaction.followUp === 'function') {
            message = await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
        } else if (typeof interaction.reply === 'function') {
            await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
            message = await interaction.fetchReply?.() || null;
        }
        if (message) scheduleEphemeralDelete(message);
        return Boolean(message);
    } catch (error) {
        logDiscordFailure(null, 'ephemeral-reply', error, interaction.user?.id);
        return false;
    }
}

async function sendComponentError(interaction, content) {
    return sendEphemeral(interaction, { content });
}

async function confirmComponent(interaction, content) {
    return sendEphemeral(interaction, { content });
}

// ── 会话 ──────────────────────────────────────────────────────────────────────

class LiarsBarGame {
    constructor({ initiatorId, channel, guild, rng = null }) {
        this.type = 'liars_bar';
        this.id = randomUUID().toString().replace(/-/g, '').slice(0, 12);
        this.initiatorId = initiatorId;
        this.channel = channel;
        this.guild = guild;
        this.guildId = guild?.id || null;
        this.channelId = channel?.id || null;
        this.participants = [initiatorId];
        this.participantIds = [initiatorId];

        this.status = 'recruit'; // recruit / playing / ended
        this.state = null;
        this.rng = rng || null;

        this.panels = [];
        this.timers = new Set();
        this.turnTimer = null;
        this.lastEvent = '';
        this.finalWinnerId = null;

        // 出局惩罚（每次出局当场结算一次）：待定败者 + 惩罚决定人。
        this.penaltyPending = false;
        this.penaltyApplied = false;
        this.penaltyLoserId = null;
        this.penaltyDeciderId = null;
        this.penaltyScope = 'normal'; // normal / surrender
        this.settlementArmed = false;

        this.mainPanelSent = false;
        this.resumed = false;
        this.panelColor = 0x9B59B6;
        this.released = false;
        this.announcedPlayer = null;
        this.pingCurrentTurn = false;
        // 惩罚完成但游戏还要继续的叙述行，下一张主面板带出。
        this.pendingAnnouncement = '';
        // 本回合开始时间戳（出牌用时是公开的心理 tell）。
        this.turnStartedAt = Date.now();
    }

    // ── 派生 ──

    get title() {
        return '🍸 骗子酒馆';
    }

    shortName(userId) {
        return mention(userId);
    }

    plainName(userId) {
        const member = this.guild?.members?.cache?.get(userId);
        const name = member?.displayName;
        // 名字会进 embed 标题/按钮/复盘行：剥掉 markdown 控制字符防伪造标题层级。
        if (name) return String(name).replace(/[*_~`#|>]/g, '');
        this.guild?.members?.fetch?.(userId)?.catch?.(() => {});
        return String(`玩家${userId}`).replace(/[*_~`#|>]/g, '');
    }

    modeText() {
        return `${MIN_PLAYERS}-${MAX_PLAYERS} 人 · 卡牌吹牛`;
    }

    openingEvent() {
        const state = this.state;
        if (!state) return '';
        const lines = [`🎴 桌面点数：**${rankLabel(state.tableRank)}** —— 声称出的牌都是它，小丑 🃏 永远算真牌。`];
        const current = state.currentPlayerId;
        if (current != null) lines.push(`🎲 先手：**${this.shortName(current)}**。`);
        return lines.join('\n');
    }

    // ── 断连接续 ──

    serializeGame() {
        return {
            v: 1,
            id: this.id,
            guildId: this.guildId,
            channelId: this.channelId,
            initiatorId: this.initiatorId,
            participants: this.participants,
            status: this.status,
            lastEvent: this.lastEvent,
            panelColor: this.panelColor,
            finalWinnerId: this.finalWinnerId,
            penaltyPending: this.penaltyPending,
            penaltyApplied: this.penaltyApplied,
            penaltyLoserId: this.penaltyLoserId,
            penaltyDeciderId: this.penaltyDeciderId,
            penaltyScope: this.penaltyScope,
            pendingAnnouncement: this.pendingAnnouncement,
            panelIds: this.panels.map(entry => entry?.message?.id).filter(Boolean),
            state: this.state ? this.state.serialize() : null,
        };
    }

    persistNow() {
        if (this.released) return;
        try {
            resumeStore.save(this.id, this.serializeGame());
        } catch (error) {
            logDiscordFailure(this, 'resume-persist', error);
        }
    }

    deletePersisted() {
        try {
            resumeStore.remove(this.id);
        } catch (error) {
            logDiscordFailure(this, 'resume-delete', error);
        }
    }

    static restore(snapshot, { guild, channel }) {
        const game = new LiarsBarGame({
            initiatorId: snapshot.initiatorId,
            channel,
            guild,
        });
        game.id = snapshot.id;
        game.status = snapshot.status;
        game.lastEvent = snapshot.lastEvent || '';
        game.panelColor = snapshot.panelColor || 0x9B59B6;
        game.finalWinnerId = snapshot.finalWinnerId || null;
        game.penaltyPending = !!snapshot.penaltyPending;
        game.penaltyApplied = !!snapshot.penaltyApplied;
        game.penaltyLoserId = snapshot.penaltyLoserId || null;
        game.penaltyDeciderId = snapshot.penaltyDeciderId || null;
        game.penaltyScope = snapshot.penaltyScope === 'surrender' ? 'surrender' : 'normal';
        game.pendingAnnouncement = snapshot.pendingAnnouncement || '';
        game.settlementArmed = false;
        game.participants = Array.isArray(snapshot.participants) ? [...snapshot.participants] : game.participants;
        game.participantIds = [...game.participants];
        game.state = snapshot.state ? LiarsBarState.restore(snapshot.state) : null;
        game.resumed = true;
        return game;
    }

    async open() {
        return await this.renderLocked();
    }

    // ── 招募 ──

    async join(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let rejection = null;
        let changed = false;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'recruit') {
                rejection = '这局已经开始或结束了。';
                return;
            }
            if (interaction.user?.bot) {
                rejection = '机器人不能上桌。';
                return;
            }
            if (this.participants.includes(interaction.user.id)) {
                rejection = '你已经坐在这张桌子旁了。';
                return;
            }
            if (this.participants.length >= MAX_PLAYERS) {
                rejection = `这张桌子只坐得下 ${MAX_PLAYERS} 个人。`;
                return;
            }
            if (!gameManager.addPlayer(this, interaction.user.id)) {
                rejection = '你已经在另一场游戏里了。';
                return;
            }
            this.participants.push(interaction.user.id);
            this.participantIds = [...this.participants];
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (!changed) {
            await sendComponentError(interaction, '这局已经开始或结束了。');
            return;
        }
        await this.refreshMainPanelLocked();
        await confirmComponent(interaction, '🪑 你坐下了。等发起人开局。');
    }

    async leaveRecruit(interaction) {
        // 招募阶段未开局就退出：直接放下桌。
        await deferComponent(interaction, { ephemeral: true });
        let rejection = null;
        let changed = false;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'recruit') {
                rejection = '这局已经开始，不能这样离席（局内可用认输）。';
                return;
            }
            if (interaction.user?.id === this.initiatorId) {
                rejection = '发起人请用 🛑 取消整局。';
                return;
            }
            if (!this.participants.includes(interaction.user?.id)) {
                rejection = '你没有坐在这张桌子旁。';
                return;
            }
            gameManager.removePlayer(this, interaction.user.id);
            this.participants = this.participants.filter(p => p !== interaction.user.id);
            this.participantIds = [...this.participants];
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (!changed) {
            await sendComponentError(interaction, '你没有坐在这张桌子旁。');
            return;
        }
        await this.refreshMainPanelLocked();
        await confirmComponent(interaction, '🚪 你离开了桌子。');
    }

    async startByInitiator(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let rejection = null;
        let changed = false;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'recruit') {
                rejection = '这局已经开始或结束了。';
                return;
            }
            if (interaction.user?.id !== this.initiatorId) {
                rejection = '只有发起人可以开局。';
                return;
            }
            if (this.participants.length < MIN_PLAYERS) {
                rejection = `至少要有 ${MIN_PLAYERS} 名玩家才能开局。`;
                return;
            }
            this.startLocked();
            this.lastEvent = `🍸 人齐了，发牌。\n${this.openingEvent()}`;
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (!changed) {
            await sendComponentError(interaction, '这局已经开始或结束了。');
            return;
        }
        await this.sendBroadcastLocked({ title: '🍸 开局发牌' });
        await this.renderLocked();
        try {
            this.onGameStarted?.([this.initiatorId]);
        } catch (error) {
            logDiscordFailure(this, 'on-game-started', error, this.initiatorId);
        }
        await confirmComponent(interaction, '🍸 牌已发下。祝各位手气「诚实」。');
    }

    async cancelByInitiator(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let rejection = null;
        let changed = false;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'recruit') {
                rejection = '这局已经开始，不能取消。';
                return;
            }
            if (interaction.user?.id !== this.initiatorId) {
                rejection = '只有发起人可以取消。';
                return;
            }
            this.status = 'ended';
            this.lastEvent = '🛑 发起人收了桌子，这局取消。';
            changed = true;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        await this.renderLocked();
        await confirmComponent(interaction, '🛑 桌子收了。');
    }

    // ── 行动 ──

    async act(interaction, action, expectedToken, { cardIndexes = null } = {}) {
        if (!await deferComponent(interaction, { ephemeral: false })) return;
        let result = null;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) {
                rejection = EXPIRED_MESSAGE;
                return;
            }
            // 质疑：任意存活玩家可抢（先到先得，抢错自己翻左轮）；出牌：仅当前行动者。
            if (action === 'challenge'
                && interaction.user?.id !== this.state.currentPlayerId
                && this.state.canChallenge(interaction.user.id)) {
                // fall through 到 apply（抢质疑路径）
            } else if (interaction.user?.id !== this.state.currentPlayerId) {
                rejection = NOT_YOUR_TURN_MESSAGE;
                return;
            }
            try {
                result = this.state.apply(action, interaction.user.id, { expectedToken, cardIndexes });
            } catch (error) {
                if (error instanceof InvalidAction) {
                    rejection = error.message;
                    return;
                }
                logDiscordFailure(this, 'act', error, interaction.user?.id);
                rejection = ACT_FAILED_MESSAGE;
            }
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (!result) {
            await sendComponentError(interaction, ACT_FAILED_MESSAGE);
            return;
        }
        await this.afterActionLocked(result);
    }

    // 出牌选择菜单：仅登记所选（防误触，不直接生效），等「确认出牌」按钮提交。
    // 反馈走原地编辑这条 ephemeral 消息（不发新面板，避免刷屏）。
    async playFromSelect(interaction, expectedToken) {
        await deferComponent(interaction, { ephemeral: true });
        const values = interaction.values || [];
        const indexes = values.map(v => Number(v)).filter(Number.isInteger);
        const state = this.state;
        if (!state || !indexes.length) return;
        const userId = interaction.user?.id;
        if (this.status !== 'playing'
            || userId !== state.currentPlayerId
            || state.turnToken !== expectedToken) {
            await sendComponentError(interaction, EXPIRED_MESSAGE);
            return;
        }
        this.pendingPlay = { userId, turnToken: expectedToken, indexes };
        const labels = indexes
            .map(i => CARD_LABELS[state.handCards(userId)[i]] || '?')
            .join('　');
        await sendEphemeral(interaction, {
            content: `已选：${labels} —— 点 **✅ 确认出牌** 落子，或重新选牌。`,
        });
    }

    // 确认出牌：按登记的所选落子（登记人与当前回合再复检）。
    async confirmPlay(interaction, expectedToken) {
        const pending = this.pendingPlay;
        const userId = interaction.user?.id;
        const state = this.state;
        if (!pending
            || pending.userId !== userId
            || this.status !== 'playing'
            || !state
            || state.turnToken !== expectedToken
            || state.turnToken !== pending.turnToken) {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '选牌已过期，请重新打开出牌面板。');
            return;
        }
        if (!pending.indexes || !pending.indexes.length) {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '请先在上方菜单选牌，再点确认。');
            return;
        }
        this.pendingPlay = null;
        await this.act(interaction, 'play_cards', expectedToken, { cardIndexes: pending.indexes });
    }

    async afterActionLocked(result) {
        this.lastEvent = this.safeFormatResult(result);
        this.panelColor = this.resultColor(result);
        if (result.action === 'play_cards') {
            // 出牌：独立播报面板（盖牌张数 + 用时心理 tell）+ 新主面板（ping 下家）。
            const seconds = this.turnStartedAt
                ? Math.max(0, Math.round((Date.now() - this.turnStartedAt) / 1000)) : null;
            const pace = seconds == null ? '' : seconds <= 5
                ? `（秒出 · ${seconds}s）` : seconds >= 40 ? `（犹豫了很久 · ${seconds}s）` : `（${seconds}s）`;
            this.turnStartedAt = Date.now();
            await this.sendBroadcastLocked({
                title: `🃏 ${this.plainName(result.actorId)} 盖出了 ${result.playedCards.length} 张牌 ${pace}`,
            });
            await this.renderLocked();
            return;
        }
        if (result.action === 'challenge') {
            // 质疑：开牌 + 左轮翻牌播报，然后要么出局惩罚结算面板，要么新一轮主面板。
            this.turnStartedAt = Date.now();
            await this.sendBroadcastLocked({ title: result.liar ? '🤥 骗子被抓！' : (result.pardonedChallenge ? '😬 质疑失败（首次失手免翻）' : '😬 质疑失败') });
            if (result.eliminatedId != null) {
                // 惩罚决定人 = 对决的另一方（质疑者/被开牌人中不是输家的那个）；
                // 终局性出局（如 2 人局）也要先惩罚再结算，决定人 = 最终胜者。
                let deciderId = result.gameEnded
                    ? result.winnerId
                    : (result.actorId === result.eliminatedId ? result.revealedBy : result.actorId);
                // 决定人若已出局（如被开的是认输者留下的声明），交给座位顺位兜底。
                if (deciderId != null && !this.state.alive.has(deciderId)) deciderId = null;
                await this.beginEliminationPenaltyLocked(result.eliminatedId, 'normal', deciderId);
            } else {
                await this.sendBroadcastLocked({ title: '🎴 新一轮' });
                await this.renderLocked();
            }
            return;
        }
        // forfeit 等其余动作由调用方自行处理播报。
        await this.renderLocked();
    }

    // 出局惩罚：惩罚决定人默认 = 座位顺位（players 数组）上出局者的下一位存活者。
    async beginEliminationPenaltyLocked(loserId, scope, deciderId = null) {
        this.penaltyPending = true;
        this.penaltyApplied = false;
        this.settlementArmed = false;
        this.penaltyLoserId = loserId;
        this.penaltyScope = scope;
        const state = this.state;
        if (deciderId == null && state) {
            const seat = state.players.indexOf(loserId);
            for (let step = 1; step <= state.players.length; step++) {
                const pid = state.players[(seat + step) % state.players.length];
                if (state.alive.has(pid) && pid !== loserId) {
                    deciderId = pid;
                    break;
                }
            }
        }
        this.penaltyDeciderId = deciderId;
        this.status = 'penalty'; // 冻结牌局等惩罚落定
        await this.renderLocked();
    }

    // 惩罚落定后恢复牌局（或终局收尾）。
    async resumeAfterPenaltyLocked() {
        const state = this.state;
        if (!state) return;
        if (state.phase === 'ended') {
            this.status = 'ended';
            this.finalWinnerId = state.winnerId;
            await this.sendBroadcastLocked({ title: '🏆 终局' });
            await this.renderLocked();
            return;
        }
        this.status = 'playing';
        // 惩罚结算期间离席的玩家：恢复对局前补判失格（每个出局者都当场受罚一次）。
        if (this.pendingInvalidations?.size && state.phase !== 'ended') {
            const pid = [...this.pendingInvalidations].find(id => state.players.includes(id) && state.alive.has(id));
            if (pid) {
                this.pendingInvalidations.delete(pid);
                state.applyForfeit(pid);
                this.lastEvent = `🏳️ **${this.shortName(pid)}** 从酒馆消失了，判负离席。`;
                this.panelColor = 0x9B59B6;
                await this.sendBroadcastLocked({ title: '🏳️ 玩家失格' });
                await this.beginEliminationPenaltyLocked(pid, 'surrender');
                return;
            }
        }
        if (this.pendingAnnouncement) {
            this.lastEvent = this.pendingAnnouncement;
            this.pendingAnnouncement = '';
            await this.sendBroadcastLocked({ title: '🎴 继续牌局' });
        }
        await this.renderLocked();
    }

    async refreshPanel(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let rejection = null;
        // 鉴权：仅本局玩家可刷新（路人乱点会造成面板无谓重发/刷屏）。
        if (!this.participants.includes(interaction.user?.id)) {
            rejection = '只有本局玩家可以刷新面板。';
        }
        let allowed = false;
        if (!rejection) {
            await gameManager.runExclusive(this, () => {
                if (['recruit', 'penalty', 'ended'].includes(this.status)) allowed = true;
                else if (this.status === 'playing' && this.state) allowed = true;
            });
        }
        if (rejection || !allowed) {
            await sendComponentError(interaction, rejection || '这局还没有可刷新的活动面板。');
            return;
        }
        // 刷新只重发面板，不重排回合计时器：否则任何参与者都能靠连点刷新
        // 无限续 62 秒回合，让超时自动出牌永远不触发（无限拖延漏洞）。
        const ok = await this.renderLocked({ armTimer: false });
        await sendEphemeral(interaction, {
            content: ok ? '🔄 已刷新当前面板。' : '🔄 面板刷新失败，请稍后再试。',
        });
    }

    // ── 认输 / 成员失格 ──

    async surrender(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let result = null;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) {
                rejection = '这局还没开始或已经结束了。';
                return;
            }
            if (!this.state.players.includes(interaction.user?.id) || !this.state.alive.has(interaction.user.id)) {
                rejection = '只有局内存活玩家可以认输。';
                return;
            }
            try {
                result = this.state.applyForfeit(interaction.user.id);
            } catch (error) {
                if (error instanceof InvalidAction) {
                    rejection = error.message;
                    return;
                }
                logDiscordFailure(this, 'surrender', error, interaction.user?.id);
                rejection = ACT_FAILED_MESSAGE;
            }
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (!result) {
            await sendComponentError(interaction, ACT_FAILED_MESSAGE);
            return;
        }
        this.lastEvent = `🏳️ **${this.shortName(result.eliminatedId)}** 认输离席。\n${flavor('surrender')}`;
        this.panelColor = 0x9B59B6;
        await this.sendBroadcastLocked({ title: '🏳️ 认输离席' });
        if (result.gameEnded) {
            // 终局性认输（如 2 人局）：也要先惩罚再结算，决定人 = 最终胜者。
            await this.beginEliminationPenaltyLocked(result.eliminatedId, 'surrender', result.winnerId);
        } else {
            await this.beginEliminationPenaltyLocked(result.eliminatedId, 'surrender');
        }
        await confirmComponent(interaction, '🏳️ 你离开了酒馆。');
    }

    // ── 定时器 ──

    schedule(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            fn();
        }, Math.min(ms, 2 ** 31 - 1));
        t.unref?.();
        this.timers.add(t);
        return t;
    }

    cancelTimerLocked() {
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.timers.delete(this.turnTimer);
            this.turnTimer = null;
        }
    }

    async recruitTimeout() {
        let changed = false;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'recruit') return;
            this.status = 'ended';
            this.lastEvent = '⌛ 桌子空等了一场，酒馆打烊了。招募超时。';
            changed = true;
        });
        if (changed) await this.renderLocked();
    }

    // 回合超时：自动出牌（有真牌出 1 张真牌，否则随机 1 张强制吹牛），不自动质疑。
    async turnTimeout(armedToken) {
        let result = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) return;
            if (this.state.turnToken !== armedToken) return;
            const state = this.state;
            const actorId = state.currentPlayerId;
            const hand = state.handCards(actorId);
            if (state.mustChallenge) {
                // 必须质疑（或已空手）却不动作：替 TA 开牌（规则强制，防回合悬空空转）。
                try {
                    result = state.apply('challenge', actorId, { expectedToken: armedToken });
                } catch (error) {
                    if (!(error instanceof InvalidAction)) throw error;
                }
                return;
            }
            if (!hand.length) {
                if (state.canChallenge(actorId)) {
                    try {
                        result = state.apply('challenge', actorId, { expectedToken: armedToken });
                    } catch (error) {
                        if (!(error instanceof InvalidAction)) throw error;
                    }
                }
                return;
            }
            // 每轮一手：已盖过牌的人超时 → 不能再盖，替 TA 质疑收尾（不针对特定人，
            // 引擎按 lastPlay 开牌）；还能盖 → 自动出牌（有真牌出真牌，否则随机吹牛）。
            const canPlay = state.canPlayCards(actorId, [0]);
            if (!canPlay) {
                if (state.canChallenge(actorId)) {
                    try {
                        result = state.apply('challenge', actorId, { expectedToken: armedToken });
                    } catch (error) {
                        if (!(error instanceof InvalidAction)) throw error;
                    }
                }
                return;
            }
            const honest = hand.map((card, i) => ({ card, i }))
                .filter(x => x.card === state.tableRank || x.card === 'JOKER');
            const indexes = honest.length > 0
                ? [honest[0].i]
                : [Math.floor(Math.random() * hand.length)];
            try {
                result = state.apply('play_cards', actorId, { expectedToken: armedToken, cardIndexes: indexes });
            } catch (error) {
                if (state.canChallenge(actorId)) {
                    try {
                        result = state.apply('challenge', actorId, { expectedToken: armedToken });
                    } catch (_) {}
                }
                if (!result && !(error instanceof InvalidAction)) throw error;
            }
        });
        if (result) {
            const forced = result.action === 'challenge' ? '（⏰ 超时自动质疑）' : '（⏰ 超时自动出牌）';
            this.lastEvent = `${this.safeFormatResult(result)}\n${forced}`;
            await this.afterActionLocked(result);
        } else {
            await this.armTimerLocked();
        }
    }

    startLocked() {
        this.status = 'playing';
        this.state = new LiarsBarState(this.participants, {
            rng: this.rng || defaultRng(),
        });
    }

    armTimerLocked() {
        this.cancelTimerLocked();
        if (this.status === 'recruit') {
            this.turnTimer = this.schedule(
                () => this.recruitTimeout().catch(error => logDiscordFailure(this, 'recruit-timeout', error)),
                RECRUIT_SECONDS * 1000
            );
        } else if (this.status === 'playing' && this.state) {
            const token = this.state.turnToken;
            this.turnTimer = this.schedule(
                () => this.turnTimeout(token).catch(error => logDiscordFailure(this, 'turn-timeout', error)),
                (TURN_SECONDS + GRACE_SECONDS) * 1000
            );
        }
    }

    // ── 惩罚结算超时 ──

    armSettlementTimeoutLocked() {
        if (this.settlementArmed) return;
        this.settlementArmed = true;
        this.cancelTimerLocked();
        this.turnTimer = this.schedule(
            () => this.settlementTimeout().catch(error => logDiscordFailure(this, 'settlement-timeout', error)),
            PENALTY_SETTLEMENT_SECONDS * 1000
        );
    }

    async settlementTimeout() {
        let act = false;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'penalty' || this.penaltyApplied || !this.penaltyPending) return;
            act = true;
        });
        if (act) await this.autoPenaltyLocked();
    }

    async autoPenaltyLocked() {
        const loserId = this.penaltyLoserId;
        if (loserId == null) return;
        let proceed = false;
        // 临界区内先「认领」惩罚再做网络 I/O，防与手点竞态双重施罚。
        await gameManager.runExclusive(this, () => {
            if (this.penaltyApplied || !this.penaltyPending) return;
            this.penaltyApplied = true;
            this.penaltyPending = false;
            proceed = true;
        });
        if (!proceed) return;
        const [ok, line, retryable] = await this.applyPenaltyAndNarrate(loserId, 'mute', {
            minutes: PENALTY_AUTO_MUTE_MINUTES,
        });
        if (!ok && retryable) {
            await gameManager.runExclusive(this, () => {
                if (this.status === 'penalty' && this.penaltyApplied) {
                    this.penaltyApplied = false;
                    this.penaltyPending = true;
                }
            });
            this.pendingAnnouncement += `\n${line}（决定人未在 ${PENALTY_SETTLEMENT_SECONDS} 秒内选择，自动施罚失败——仍可手动重试）`;
        } else {
            this.pendingAnnouncement += `\n${line}（决定人未在 ${PENALTY_SETTLEMENT_SECONDS} 秒内选择，自动禁言 ${PENALTY_AUTO_MUTE_MINUTES} 分钟）`;
            await this.resumeAfterPenaltyLocked();
        }
        if (!ok || !retryable) {
            await this.renderLocked();
        }
    }

    async applyPenaltyAndNarrate(loserId, penaltyType, { nickname = null, minutes = null } = {}) {
        let ok = false;
        let message = '';
        let retryable = false;
        try {
            [ok, message, retryable] = await this.applyPenalty(this.guild, loserId, penaltyType, { nickname, minutes });
        } catch (error) {
            logDiscordFailure(this, 'penalty', error, loserId);
            ok = false;
            message = '惩罚调用异常（网络或内部错误）';
            retryable = true;
        }
        if (ok) return [true, `🔒 出局者 **${this.shortName(loserId)}**：${message}`, false];
        return [false, `⚠️ 出局者 **${this.shortName(loserId)}** 惩罚未生效：${message}`, retryable];
    }

    async finalizePenalty(interaction, penaltyType, nickname) {
        const deferred = await deferComponent(interaction, { ephemeral: true });
        if (!deferred) return;
        let rejection = null;
        let ok = false;
        let loserId = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'penalty') {
                rejection = '现在没有待结算的惩罚。';
                return;
            }
            if (this.penaltyApplied) {
                rejection = '惩罚已经处理过了。';
                return;
            }
            if (interaction.user?.id !== this.penaltyDeciderId) {
                rejection = '只有惩罚决定人可以选择。';
                return;
            }
            this.penaltyApplied = true;
            this.penaltyPending = false;
            loserId = this.penaltyLoserId;
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        if (loserId == null) {
            await sendComponentError(interaction, '现在没有待结算的惩罚。');
            return;
        }
        const [muteMin, renameMin] = this.penaltyMinutes();
        const minutes = penaltyType === 'mute' ? muteMin : renameMin;
        let line = null;
        let retryable = false;
        [ok, line, retryable] = await this.applyPenaltyAndNarrate(loserId, penaltyType, { nickname, minutes });
        if (!ok && retryable) {
            await gameManager.runExclusive(this, () => {
                if (this.status === 'penalty' && this.penaltyApplied) {
                    this.penaltyApplied = false;
                    this.penaltyPending = true;
                }
            });
        }
        if (line) this.pendingAnnouncement += `\n${line}`;
        if (ok || !retryable) {
            await this.resumeAfterPenaltyLocked();
        } else {
            await this.renderLocked();
        }
        await sendEphemeral(interaction, {
            content: ok ? '✅ 惩罚已施加。'
                : retryable ? '❌ 惩罚未能施加（网络问题），可稍后重试。'
                : '❌ 惩罚无法施加（权限不足）——原因已写在面板上。',
        });
    }

    async chooseMutePenalty(interaction) {
        await this.finalizePenalty(interaction, 'mute', null);
    }

    async chooseRenamePenalty(interaction, nickname) {
        await this.finalizePenalty(interaction, 'rename', nickname);
    }

    async openRenameModal(interaction) {
        // 纯读取校验不走 runExclusive（Modal 3s 限制），提交时 finalizePenalty 内复检。
        if (this.status !== 'penalty') {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '现在没有待结算的惩罚。');
            return;
        }
        if (this.penaltyApplied) {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '惩罚已经处理过了。');
            return;
        }
        if (interaction.user?.id !== this.penaltyDeciderId) {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '只有惩罚决定人可以选择。');
            return;
        }
        const input = new TextInputBuilder()
            .setCustomId('liars_bar_rename_input')
            .setLabel('要给出局者改成的昵称（最多 32 字）')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(32)
            .setPlaceholder('例如：🤥 今晚的骗子');
        const modal = new ModalBuilder()
            .setCustomId(`${RENAME_MODAL_PREFIX}:${this.id}`)
            .setTitle('✏️ 出局者改名惩罚')
            .addComponents(new ActionRowBuilder().addComponents(input));
        try {
            await interaction.showModal(modal);
        } catch (error) {
            logDiscordFailure(this, 'show-rename-modal', error, interaction.user?.id);
        }
    }

    // ── 渲染 ──

    ensureReleased() {
        if (this.status === 'penalty' && this.penaltyPending && !this.penaltyApplied) return;
        if (this.status === 'ended' && this.penaltyPending && !this.penaltyApplied) return;
        if (this.released) return;
        this.released = true;
        this.disableAllComponents();
        this.settlementArmed = false;
        this.deletePersisted();
        return gameManager.cleanupGame(this);
    }

    teardownNoSend() {
        this.status = 'ended';
        this.cancelTimerLocked();
        this.ensureReleased();
    }

    buildPanel() {
        if (this.status === 'recruit') {
            return { embed: this.recruitEmbed(), rows: this.recruitViewRows(), interactive: true };
        }
        if (this.status === 'playing' && this.state) {
            return { embed: this.playEmbed(), rows: this.gameViewRows(), interactive: true };
        }
        if (this.status === 'penalty') {
            const rows = this.settlementViewRows();
            return { embed: this.penaltyEmbed(), rows, interactive: rows.length > 0 };
        }
        const rows = this.settlementViewRows();
        return { embed: this.settlementEmbed(), rows, interactive: rows.length > 0 };
    }

    async renderLocked({ armTimer = true } = {}) {
        this.persistNow();
        const first = this.panels.length === 0;
        this.pingCurrentTurn = false;
        let entry = null;
        try {
            const { embed, rows, interactive } = this.buildPanel();
            let finalRows = rows;
            const current = this.state?.currentPlayerId;
            if (this.status === 'playing' && this.state && current != null) {
                if (!rows.length) {
                    logDiscordFailure(this, 'rows-fallback', new Error(`turn got empty rows`), current);
                    finalRows = this.guaranteedTurnRows(this.state);
                }
            }
            const message = await this.channel.send({
                embeds: [embed],
                components: interactive ? finalRows : [],
                allowedMentions: this.panelMentions(),
            });
            entry = { message, interactive };
        } catch (error) {
            logDiscordFailure(this, 'render', error);
            if (this.status === 'playing' && this.state && this.state.currentPlayerId != null && entry == null) {
                try {
                    const embed = this.playEmbed();
                    const fallbackRows = this.guaranteedTurnRows(this.state);
                    const message = await this.channel.send({
                        embeds: [embed],
                        components: fallbackRows,
                        allowedMentions: { parse: [], users: [], repliedUser: false },
                    });
                    entry = { message, interactive: true };
                } catch (error2) {
                    logDiscordFailure(this, 'render-fallback-retry', error2);
                }
                if (entry) this.mainPanelSent = true;
            }
            if (!this.mainPanelSent) {
                this.teardownNoSend();
                return false;
            }
            if (armTimer && ['recruit', 'playing'].includes(this.status)) {
                this.armTimerLocked();
            } else if (['ended', 'penalty'].includes(this.status)) {
                this.cancelTimerLocked();
                this.ensureReleased();
            }
            return true;
        }

        try {
            if (!first) await this.disablePreviousButtonsLocked();
            this.panels.push(entry);
            this.mainPanelSent = true;
            this.persistNow();
            if (['recruit', 'playing'].includes(this.status)) {
                await this.pruneWindowLocked();
                if (armTimer) this.armTimerLocked();
            } else {
                this.cancelTimerLocked();
                await this.pruneToFinalLocked(entry);
                this.ensureReleased();
                if (this.penaltyPending && !this.penaltyApplied) {
                    this.armSettlementTimeoutLocked();
                }
            }
        } catch (error) {
            logDiscordFailure(this, 'render-cleanup', error);
            if (['recruit', 'playing'].includes(this.status)) {
                try {
                    this.armTimerLocked();
                } catch (error2) {
                    this.teardownNoSend();
                }
            } else {
                this.ensureReleased();
                if (this.penaltyPending && !this.penaltyApplied) {
                    try {
                        this.armSettlementTimeoutLocked();
                    } catch (error2) {
                        logDiscordFailure(this, 'render-cleanup-settlement', error2);
                    }
                }
            }
        }
        return true;
    }

    async refreshMainPanelLocked() {
        this.persistNow();
        if (!this.panels.length || !['playing', 'recruit'].includes(this.status)) {
            await this.renderLocked();
            return;
        }
        try {
            const { embed, rows, interactive } = this.buildPanel();
            let finalRows = rows;
            const current = this.state?.currentPlayerId;
            if (this.status === 'playing' && this.state && current != null && !rows.length) {
                logDiscordFailure(this, 'refresh-main-rows-fallback', new Error('refresh edit got empty rows'), current);
                finalRows = this.guaranteedTurnRows(this.state);
            }
            const entry = [...this.panels].reverse().find(e => e.interactive);
            if (!entry) {
                await this.renderLocked();
                return;
            }
            await entry.message.edit({
                embeds: [embed],
                components: interactive ? finalRows : [],
                allowedMentions: this.panelMentions(),
            });
            entry.interactive = interactive;
        } catch (error) {
            logDiscordFailure(this, 'refresh-main', error);
            await this.renderLocked();
            return;
        }
        this.armTimerLocked();
    }

    async sendBroadcastLocked({ title }) {
        if (!this.lastEvent) return;
        if (typeof this.channel?.send !== 'function') return;
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(this.panelColor)
            .setAuthor({ name: `${this.title} · ${this.modeText()}` })
            .setDescription(this.lastEvent);
        let message;
        try {
            message = await this.channel.send({
                embeds: [embed],
                allowedMentions: { parse: [], users: [], repliedUser: false },
            });
        } catch (error) {
            logDiscordFailure(this, 'broadcast', error);
            return;
        }
        this.panels.push({ message, interactive: false });
        await this.pruneWindowLocked();
    }

    async disablePreviousButtonsLocked() {
        for (const entry of this.panels) {
            if (!entry.interactive) continue;
            entry.interactive = false;
            try {
                await entry.message.edit({
                    components: [],
                    allowedMentions: { parse: [], users: [], repliedUser: false },
                });
            } catch (error) {
                logDiscordFailure(this, 'disable-previous-buttons', error);
            }
        }
    }

    async pruneWindowLocked() {
        while (this.panels.length > PANEL_HISTORY_LIMIT) {
            const entry = this.panels.shift();
            try {
                await entry.message.delete();
            } catch (error) {
                logDiscordFailure(this, 'prune-window', error);
            }
        }
    }

    async pruneToFinalLocked(keep) {
        const doomed = this.panels.filter(entry => entry !== keep);
        this.panels = [keep];
        for (const entry of doomed) {
            try {
                await entry.message.delete();
            } catch (error) {
                logDiscordFailure(this, 'prune-to-final', error);
            }
        }
    }

    panelMentions() {
        const pingIds = [];
        if (this.status === 'recruit') {
            // 招募面板不特意 ping 谁（发起人自己知道）。
        } else if (this.status === 'playing' && this.state && this.pingCurrentTurn) {
            const current = this.state.currentPlayerId;
            if (current != null) pingIds.push(current);
        } else if (this.status === 'penalty' && this.penaltyPending && !this.penaltyApplied) {
            if (this.penaltyDeciderId != null) pingIds.push(this.penaltyDeciderId);
        }
        this.pingCurrentTurn = false;
        return { parse: [], users: pingIds, repliedUser: false };
    }

    // ── 面板文案 ──

    recruitEmbed() {
        const embed = new EmbedBuilder()
            .setTitle('🍸 骗子酒馆开张')
            .setColor(0x5865F2)
            .setAuthor({ name: `${this.title} · ${this.modeText()}` });
        const deadline = Math.floor(Date.now() / 1000) + RECRUIT_SECONDS;
        const seated = this.participants.map(p => mention(p)).join('　');
        embed.setDescription(
            `**${this.shortName(this.initiatorId)}** 摆开了一张酒馆牌桌。\n\n`
            + '**怎么玩**：每轮亮一张「桌面点数」，每人盖一手牌（1-3 张）声称全是它——可以撒谎；'
            + '任何人都能**质疑（=开牌：翻开上一手验证真假）**——抓到骗子，骗子翻左轮；质疑失手首次只记警告，再失手才翻（首翻 1/4 致命，越翻越危险）：空包侥幸，致命出局。\n\n'
            + `🪑 已入座（${this.participants.length}/${MAX_PLAYERS}）：${seated}\n\n`
            + `🔨 每个出局者都当场受罚：抓到的人（或顺位存活者）给输家选 🔇 禁言 ${PENALTY_MUTE_MINUTES} 分 / ✏️ 改名 ${PENALTY_RENAME_MINUTES} 分；活到最后的唯一幸存者是胜者，不受罚。\n\n`
            + `⏳ <t:${deadline}:R> 后桌子自动收摊；发起人可随时点 **🎬 开局**（≥${MIN_PLAYERS} 人）。`
        );
        embed.setFooter({ text: '小丑 🃏 永远算真牌——留着它，关键时刻能救你一命（或骗到别人）。' });
        return embed;
    }

    recruitViewRows() {
        const row = new ActionRowBuilder();
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_join:${this.id}`)
                .setLabel('🪑 上桌')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_leave:${this.id}`)
                .setLabel('🚪 离桌')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_start:${this.id}`)
                .setLabel('🎬 发起人开局')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_cancel:${this.id}`)
                .setLabel('🛑 取消')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_item_help:${this.id}:${this.state?.turnToken ?? ''}`)
                .setLabel(ITEM_HELP_LABEL)
                .setStyle(ButtonStyle.Secondary)
        );
        return [row];
    }

    playEmbed() {
        const state = this.state;
        if (!state) {
            return new EmbedBuilder()
                .setTitle(this.title)
                .setColor(this.panelColor)
                .setDescription(this.lastEvent || '游戏尚未开始。');
        }
        const current = state.currentPlayerId;
        const resumed = this.resumed;
        if (resumed) this.resumed = false;
        const title = resumed ? '🔁 断连接续 · 🎴 出牌回合' : '🎴 出牌回合';
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(this.panelColor)
            .setAuthor({ name: `${this.title} · 第 ${state.roundNumber} 轮` });

        const parts = [];
        let isNewTurn = false;
        if (current != null) {
            isNewTurn = current !== this.announcedPlayer;
            if (isNewTurn) {
                this.announcedPlayer = current;
                this.pingCurrentTurn = true;
            }
        }
        if (current != null) {
            if (isNewTurn) {
                // 大字醒目：回合切换时单独一行强调当前行动者（配合 ping）。
                parts.push(state.mustChallenge
                    ? `# ⚡轮到 ${this.plainName(current)} 开牌！`
                    : `# ⚡轮到 ${this.plainName(current)} 出牌！`);
            }
            parts.push(`⏳ <t:${Math.floor(Date.now() / 1000) + TURN_SECONDS + GRACE_SECONDS}:R> 超时自动出牌（不会替你质疑）`);
            if (state.mustChallenge) parts.push('⚠️ 全员已盖完牌——**必须开牌质疑**！');
            parts.push('');
        }
        parts.push(`**🎴 桌面点数：${rankLabel(state.tableRank)}**`);
        // 本轮声明链：盖牌是暗的，但"谁盖了几张"是公开动作——异步对局里人最容易忘这个。
        if (state.roundPlays?.length) {
            parts.push(`📜 本轮声明：${state.roundPlays.map(rp => `${this.shortName(rp.playerId)}×${rp.count}`).join(' → ')}（可质疑最后一手）`);
        }
        if (state.lastPlay != null) {
            parts.push(`**${this.shortName(state.lastPlay.playerId)}** 盖了 **${state.lastPlay.count}** 张`);
        } else {
            parts.push('第一手出牌中（第一手不可质疑）');
        }
        parts.push('', '');
        embed.setDescription(parts.join('\n'));

        // 玩家区块：当前行动者置顶；左轮压力随已翻次数递增直观化。
        const ordered = current != null
            ? [current, ...state.players.filter(p => p !== current)]
            : state.players;
        for (let idx = 0; idx < ordered.length; idx++) {
            const playerId = ordered[idx];
            const alive = state.alive.has(playerId);
            const fname = !alive ? '💀 已出局' : (playerId === current ? '▶️ 行动中' : '等待');
            const odds = state.lethalOdds(playerId);
            // 中弹率用分数直观呈现（1/4、1/3、1/2、必死），比压力条干净。
            const denom = Math.max(1, Math.round(1 / odds));
            const oddsText = odds >= 1 ? '必死' : `1/${denom}（${(odds * 100).toFixed(0)}%）`;
            const played = state.playedThisRound.has(playerId) ? '✅ 已盖牌' : '⬜ 未盖';
            const lines = [
                `${mention(playerId)}　🎴 手牌 ${alive ? state.handCards(playerId).length : 0}　${played}`,
                `🔫 中弹率：${oddsText}`,
            ];
            if (idx < ordered.length - 1) lines.push('​');
            embed.addFields([{ name: fname, value: lines.join('\n'), inline: false }]);
        }
        return embed;
    }

    // 出牌选择菜单：当前手牌逐张列出（label 带牌面，value=手牌索引）。
    // 手牌是私密信息——选择菜单对所有人可见，所以**不在这里放菜单**；
    // 出牌走「🃏 出牌」按钮 → ephemeral 私密面板（手牌菜单+质疑按钮）。
    gameViewRows() {
        const state = this.state;
        if (!state) return [];
        const current = state.currentPlayerId;
        if (current == null) return [];

        try {
            const row0 = new ActionRowBuilder();
            const playBtn = new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_play_card:${this.id}:${state.turnToken}`)
                .setLabel(`🃏 出牌（@${this.plainName(current)}）`)
                .setStyle(ButtonStyle.Primary);
            if (state.mustChallenge || state.playedThisRound.has(current) || !state.handCards(current).length) {
                playBtn.setDisabled(true); // 必须质疑/已盖过/空手：禁用出牌
            }
            row0.addComponents(playBtn);
            // 质疑对全桌开放（除上一手出牌人）：谁都能拍桌，抢错自己翻左轮。
            const anyChallenger = state.players.some(p => state.canChallenge(p));
            const challengeBtn = new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_challenge:${this.id}:${state.turnToken}`)
                .setLabel(state.lastPlay ? `🤥 质疑 @${this.plainName(state.lastPlay.playerId)}！` : '🤥 质疑上一手！')
                .setStyle(ButtonStyle.Danger);
            if (!anyChallenger) challengeBtn.setDisabled(true); // 第一手：无人可质疑
            row0.addComponents(challengeBtn);
            const lastRow = new ActionRowBuilder();
            lastRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`mystery_liars_bar_refresh:${this.id}`)
                    .setLabel('🔄 刷新面板')
                    .setStyle(ButtonStyle.Secondary)
            );
            this.addItemHelpButton(lastRow);
            return [row0, lastRow];
        } catch (error) {
            logDiscordFailure(this, 'game-rows-fallback', error, current);
            return this.guaranteedTurnRows(state);
        }
    }

    guaranteedTurnRows(state) {
        const row0 = new ActionRowBuilder();
        row0.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_play_card:${this.id}:${state.turnToken}`)
                .setLabel('🃏 出牌')
                .setStyle(ButtonStyle.Primary)
        );
        const lastRow = new ActionRowBuilder();
        this.addItemHelpButton(lastRow);
        return [row0, lastRow];
    }

    // 私密出牌面板（ephemeral）：手牌选择菜单（仅选牌，不生效）+ 确认出牌按钮 + 质疑按钮。
    // 选择菜单原生是多选即发——为防误触，选中后必须点「✅ 确认出牌」才真正落子；
    // 确认时按菜单当前选中值出牌（未选则提示）。
    privatePlayViewRows(state, userId) {
        const rows = [];
        const hand = state.handCards(userId);
        const alreadyPlayed = state.playedThisRound.has(userId);
        if (hand.length > 0 && !alreadyPlayed) {
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`mystery_liars_bar_play_select:${this.id}:${state.turnToken}`)
                .setPlaceholder(`选牌（1-${MAX_PLAY_CARDS} 张），选完点下方「确认出牌」`)
                .setMinValues(1)
                .setMaxValues(Math.min(MAX_PLAY_CARDS, hand.length))
                .addOptions(
                    hand.map((card, i) => new StringSelectMenuOptionBuilder()
                        .setLabel(`${CARD_LABELS[card] || card}`)
                        .setValue(String(i))
                        .setDescription(
                            card === 'JOKER' ? '万能牌：每手只认第一张小丑'
                                : card === state.tableRank ? '与桌面点数一致（真牌）'
                                : '与桌面点数不符（吹牛！）'
                        ))
                );
            rows.push(new ActionRowBuilder().addComponents(menu));
            rows.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`mystery_liars_bar_confirm_play:${this.id}:${state.turnToken}`)
                    .setLabel('✅ 确认出牌')
                    .setStyle(ButtonStyle.Success)
            ));
        }
        const row = new ActionRowBuilder();
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_challenge:${this.id}:${state.turnToken}`)
                .setLabel('🤥 质疑上一手！')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!state.canChallenge(userId))
        );
        rows.push(row);
        return rows;
    }

    // 「🃏 出牌」按钮：当前行动者点击 → 弹 ephemeral 私密面板（手牌+出牌菜单+质疑）。
    async openPrivatePlay(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let rejection = null;
        let embed = null;
        let rows = null;
        await gameManager.runExclusive(this, () => {
            const state = this.state;
            if (this.status !== 'playing' || !state) {
                rejection = '这局还没开始或已经结束了。';
                return;
            }
            const userId = interaction.user?.id;
            if (!state.players.includes(userId)) {
                rejection = '只有本局玩家可以操作。';
                return;
            }
            if (userId !== state.currentPlayerId) {
                rejection = NOT_YOUR_TURN_MESSAGE;
                return;
            }
            embed = this.privatePlayEmbed(userId);
            rows = this.privatePlayViewRows(state, userId);
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        await sendEphemeral(interaction, { embeds: [embed], components: rows });
    }

    privatePlayEmbed(userId) {
        const state = this.state;
        const alreadyPlayed = state.playedThisRound.has(userId);
        const lastLine = state.lastPlay != null
            ? `上一手：**${this.plainName(state.lastPlay.playerId)}** 盖了 **${state.lastPlay.count}** 张`
            : '你是本轮第一手（不可被质疑）';
        // 决策参考只给真正公开的信息：全场真牌固定 8 张（K/Q/A 各 6 + 2 小丑）。
        // 不能聚合"全场手牌+盖牌中的真牌数"——2/3 人局该值随发牌波动且不可推导，
        // 会把推理题变成读数题（极端牌型下可推出必中质疑）。
        const rank = state.tableRank;
        const ownTrue = state.handCards(userId).filter(c => c === rank || c === 'JOKER').length;
        const refLine = `📊 参考：全场真牌（${rank} 点+小丑）共 **8 张**，你手里 ${ownTrue} 张`;
        const odds = state.lethalOdds(userId);
        const denom = Math.max(1, Math.round(1 / odds));
        const oddsText = odds >= 1 ? '必死' : `1/${denom}`;
        return new EmbedBuilder()
            .setTitle(`🎴 ${rankLabel(state.tableRank)} · 仅你可见`)
            .setColor(0x5865F2)
            .setDescription(
                `${lastLine}\n`
                + `${refLine}\n`
                + `🔫 你的中弹率：${oddsText}\n\n`
                + `**你的手牌**（${state.handCards(userId).length} 张）：\n${state.handText(userId)}\n\n`
                + (state.mustChallenge
                    ? '⚠️ 全员已盖完牌——**必须开牌质疑**！'
                    : alreadyPlayed
                        ? '✅ 你本轮已盖过牌——等待开牌，或点 **🤥 质疑**。'
                        : '选牌 → **✅ 确认出牌**，或点 **🤥 质疑**。🃏 小丑万能（每手只认第一张）。')
            );
    }

    rulesEmbed() {
        return new EmbedBuilder()
            .setTitle('📖 游戏规则')
            .setColor(0x5865F2)
            .setAuthor({ name: `${this.title} · 仅你可见` })
            .setDescription(
                '**🎴 牌与轮次**\n'
                + `骗子牌堆：K/Q/A 各 6 张 + 2 张小丑 🃏（万能，开牌时永远算真牌）；`
                + `每轮翻一张桌面点数（K/Q/A 之一），每人发 ${HAND_SIZE} 张手牌。\n\n`
                + '**🃏 出牌与质疑**\n'
                + `每轮每人**只能盖一手牌**（1-${MAX_PLAY_CARDS} 张，张数自选）：出少了稳妥、出多了压缩轮次但吹牛风险集中。`
                + '声称「全是桌面点数」——可以撒谎。\n'
                + '**🤥 质疑对全桌开放**：任何其他玩家（不限下家）都可**抢先拍桌**——先到先得。\n'
                + '　• 非桌面点数的牌 = 假牌；小丑万能但**每手只认第一张**（第二张起算假牌）；\n'
                + '　• 被抓的骗子翻 1 张左轮；质疑失败首次免翻只记警告，再次失手才翻；\n'
                + '　• 第一手不可质疑；全员盖完/无牌可盖时强制开牌。\n\n'
                + '**🔫 出局惩罚（左轮牌堆）**\n'
                + '左轮翻牌者（被抓的骗子 / 失手两次的质疑者）翻自己专属左轮牌堆顶牌（1 致命 + 3 空包共 4 张，'
                + '统一翻 1 张、翻掉不回填，越罚越危险——首翻 1/4，第 4 发必死）：\n'
                + '　• 空包——侥幸存活，继续下一轮；\n'
                + `　• 致命——出局，并由抓到的人选择 🔇 禁言 ${PENALTY_MUTE_MINUTES} 分 / ✏️ 改名 ${PENALTY_RENAME_MINUTES} 分`
                + `（${PENALTY_SETTLEMENT_SECONDS} 秒不选自动禁言 ${PENALTY_AUTO_MUTE_MINUTES} 分）。\n\n`
                + '**🔁 流转**：新一轮先手 = 上一轮输家的下家；桌面点数牌堆翻尽重洗。\n\n'
                + '**🏆 胜利与惩罚总则**：**每个出局者都当场受罚一次**（质疑致命 / 认输 / 失格，'
                + '认输与失格减轻为 3 / 6 分）；活到最后的**唯一幸存者是胜者，不受任何惩罚**。\n\n'
                + `**⏱ 回合**：每回合 ${TURN_SECONDS} 秒，超时自动出牌（有真牌出真牌，没真牌随机吹牛），不会自动质疑。\n\n`
                + '**⚠️ 与原版 Liar\'s Bar 的差异**（玩过原版的请留意）：\n'
                + '　• **每轮每人一手牌**：盖过就得等开牌（原版可多手）；\n'
                + '　• **质疑全桌开放**：任何玩家可抢先质疑上一手（原版仅下家）；\n'
                + '　• **左轮 1 实 3 空共 4 张**（原版 1 实 5 空共 6 张）——节奏更快、压力更陡；\n'
                + '　• 出局惩罚由「左轮必死」改为左轮牌堆翻牌 + 抓到的人选禁言/改名；\n'
                + '　• 每轮手牌固定 5 张（原版按人数扩堆）。'
            );
    }

    async showItemHelp(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        await sendEphemeral(interaction, {
            embeds: [this.rulesEmbed()],
            components: this.privateIntelViewRows(interaction.user?.id),
        });
    }

    privateIntelViewRows(userId) {
        // 规则面板附带认输按钮（局内存活玩家可用）。
        const state = this.state;
        const isPlayer = state != null && userId != null
            && state.players.includes(userId) && state.alive.has(userId);
        const canSurrender = this.status === 'playing' && isPlayer;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_surrender:${this.id}`)
                .setLabel(canSurrender ? '🏳️ 认输离席' : '🏳️ 认输（不可用）')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(!canSurrender)
        );
        return [row];
    }

    penaltyMinutes() {
        if (this.penaltyScope === 'surrender') {
            return [SURRENDER_MUTE_MINUTES, SURRENDER_RENAME_MINUTES];
        }
        return [PENALTY_MUTE_MINUTES, PENALTY_RENAME_MINUTES];
    }

    penaltyEmbed() {
        const embed = new EmbedBuilder()
            .setTitle('🔨 出局惩罚')
            .setColor(0xF1C40F)
            .setAuthor({ name: this.title });
        const parts = [];
        if (this.lastEvent) parts.push(this.lastEvent);
        if (this.penaltyPending && !this.penaltyApplied) {
            const [muteMin, renameMin] = this.penaltyMinutes();
            const isFinal = this.state?.phase === 'ended';
            parts.push(
                `💀 出局者：${mention(this.penaltyLoserId)}　⚖️ 惩罚决定人：${mention(this.penaltyDeciderId)}${isFinal ? '（这是最后一罚，罚完即终局）' : ''}\n`
                + `🔨 **${mention(this.penaltyDeciderId)}，轮到你决定惩罚**：`
                + `🔇 禁言 ${muteMin} 分钟，或 ✏️ 改名 ${renameMin} 分钟（可自定义新名字）——点下方按钮。`
                + `${PENALTY_SETTLEMENT_SECONDS} 秒内不选，桌子替你做主：**自动禁言 ${PENALTY_AUTO_MUTE_MINUTES} 分钟**。`
            );
        }
        embed.setDescription(parts.join('\n\n'));
        return embed;
    }

    settlementEmbed() {
        const embed = new EmbedBuilder()
            .setTitle('🏆 结算')
            .setColor(0xF1C40F)
            .setAuthor({ name: this.title });
        const parts = [];
        if (this.finalWinnerId != null) {
            const state = this.state;
            // 出局名单回顾（座位顺序），给终局一点仪式感。
            let roster = '';
            if (state) {
                const eliminated = state.players.filter(p => !state.alive.has(p));
                if (eliminated.length > 0) {
                    roster = `\n\n💀 今晚离席的人：${eliminated.map(p => mention(p)).join('　')}`;
                }
            }
            parts.push(`# 🏆 ${mention(this.finalWinnerId)} 是今晚最后还坐在桌前的人。${roster}\n${flavor('game_end')}`);
        }
        if (this.pendingAnnouncement) parts.push(this.pendingAnnouncement.trim());
        if (this.lastEvent) parts.push(this.lastEvent);
        embed.setDescription(parts.join('\n\n'));
        return embed;
    }

    settlementViewRows() {
        if (!this.penaltyPending || this.penaltyApplied) return [];
        const [muteMin, renameMin] = this.penaltyMinutes();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_penalty_mute:${this.id}`)
                .setLabel(`🔇 禁言 ${muteMin} 分钟`)
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_penalty_rename:${this.id}`)
                .setLabel(`✏️ 改名 ${renameMin} 分钟`)
                .setStyle(ButtonStyle.Success)
        );
        return [row];
    }

    // ── 叙述 ──

    safeFormatResult(result) {
        try {
            return this.formatResult(result);
        } catch (error) {
            logDiscordFailure(this, 'format-result', error, result.actorId);
            return `⚠️ **${this.shortName(result.actorId)}** 的操作已完成，但事件描述生成失败。`;
        }
    }

    formatResult(result) {
        const actor = this.shortName(result.actorId);
        const lines = [];
        if (result.action === 'play_cards') {
            lines.push(`🃏 ${actor} 盖出了 **${result.playedCards.length}** 张牌，声称全是 ${rankLabel(this.state?.tableRank)}。`);
        } else if (result.action === 'challenge') {
            const accused = this.shortName(result.revealedBy);
            const cards = result.revealedCards.map(cardLabel).join('　');
            lines.push(`🤥 ${actor} 质疑 ${accused}！开牌：${cards}（桌面 ${rankLabel(result.challengeTableRank)}）`);
            if (result.liar) {
                lines.push(`💥 ${accused} 撒谎了`);
            } else {
                lines.push(`😮 ${accused} 是诚实的——${actor} 冤枉好人`);
            }
            const loser = this.shortName(result.loserId);
            if (result.pardonedChallenge) {
                lines.push(`🙏 ${actor} 首次失手，免翻左轮——记一次警告，再失手就要翻了。`);
            } else {
                const flips = (result.revolverFlips || []).map(f => (f ? '💀致命' : '空包'));
                lines.push(`🔫 ${loser}：${flips.join(' → ')}`);
            }
            if (result.lethal) lines.push(`💀 **${loser} 出局**`);
            if (!result.gameEnded && result.newRound) {
                lines.push(`\n🎴 新一轮：桌面 **${rankLabel(result.newTableRank)}**，先手 ${this.shortName(result.firstPlayerId)}。`);
            }
        } else if (result.action === 'forfeit') {
            lines.push(`🏳️ **${this.shortName(result.eliminatedId)}** 离开了酒馆。`);
        }
        return lines.join('\n');
    }

    // 质疑发生时的桌面点数已由引擎带在 result.challengeTableRank。

    resultColor(result) {
        if (result.gameEnded) return 0xF1C40F;
        if (result.action === 'challenge') {
            if (result.lethal) return 0xE74C3C; // 红 — 致命出局
            if (result.liar) return 0xE67E22;   // 橙 — 抓到骗子但空包
            return 0x2ECC71;                     // 绿 — 质疑失败
        }
        return 0x9B59B6;                         // 紫 — 出牌
    }

    // ── 惩罚应用（改名复用 parliament 昵称锁，对齐 devilRouletteGame） ──

    async applyPenalty(guild, loserId, penaltyType, { nickname = null, minutes = null } = {}) {
        if (penaltyType === 'mute') {
            return this.applyMute(guild, loserId, { minutes });
        }
        return this.applyRename(guild, loserId, { nickname, minutes });
    }

    async applyMute(guild, loserId, { minutes = null } = {}) {
        const member = await this.fetchMember(guild, loserId);
        if (!member) return [false, '禁言未生效（找不到成员）', false];
        if (member.moderatable === false) {
            return [false, '禁言未生效（我的身份组层级低于对方，无法禁言 TA）', false];
        }
        const mins = minutes || PENALTY_MUTE_MINUTES;
        try {
            await member.timeout(mins * 60_000, PENALTY_MUTE_REASON);
            return [true, `已禁言 ${mins} 分钟`, false];
        } catch (error) {
            logDiscordFailure(this, 'apply-mute', error, loserId);
            const code = error?.code;
            const detail = code === 50013 ? '（我缺少「禁言成员」权限）'
                : code === 50035 ? '（时长参数被 Discord 拒收）' : `（Discord 返回错误 ${code ?? '未知'}）`;
            return [false, `禁言未生效${detail}`, code !== 50013];
        }
    }

    async applyRename(guild, loserId, { nickname = null, minutes = null } = {}) {
        const member = await this.fetchMember(guild, loserId);
        if (!member) return [false, '改名未生效（找不到成员）', false];
        const enforced = (nickname || PENALTY_NICKNAME).trim();
        if (!enforced) return [false, '改名未生效（昵称不能为空）', false];
        if (member.manageable === false) {
            return [false, '改名未生效（我的身份组层级低于对方，无法改 TA 的昵称）', false];
        }
        const renameMinutes = minutes || PENALTY_RENAME_MINUTES;
        const result = await nicknameLock.service.replaceLock({
            member,
            type: RENAME_LOCK_TYPE,
            enforcedNickname: enforced,
            expiresAt: Date.now() + renameMinutes * 60_000,
            applyReason: PENALTY_RENAME_APPLY_REASON,
            restoreReason: PENALTY_RENAME_RESTORE_REASON,
            enforceReason: PENALTY_RENAME_ENFORCE_REASON,
            channelId: this.channelId,
            expectedTypes: ORDINARY_LOCK_TYPES,
        });
        if (result.created) {
            return [true, `已强制改名 ${renameMinutes} 分钟（新昵称：${enforced}）`, false];
        }
        if (result.reason === 'existing_lock') {
            return [false, '改名未生效（对方正挂着更高优先级的昵称锁）', false];
        }
        return [false, '改名未生效（Bot 权限不足或成员状态）', false];
    }

    async fetchMember(guild, userId) {
        try {
            return await guild?.members?.fetch?.(userId) || null;
        } catch (error) {
            logDiscordFailure(this, 'fetch-member', error, userId);
            return null;
        }
    }

    // ── 收尾 ──

    disableAllComponents() {
        this.cancelTimerLocked();
        for (const entry of this.panels) {
            if (!entry.interactive) continue;
            entry.interactive = false;
            entry.message.edit({
                components: [],
                allowedMentions: { parse: [], users: [], repliedUser: false },
            }).catch(error => logDiscordFailure(this, 'disable-components', error));
        }
    }

    addItemHelpButton(row) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_liars_bar_item_help:${this.id}:${this.state?.turnToken ?? ''}`)
                .setLabel(ITEM_HELP_LABEL)
                .setStyle(ButtonStyle.Secondary)
        );
    }

}

// ── 启动入口 ──────────────────────────────────────────────────────────────────

async function startLiarsBar(interaction, { onGameStarted } = {}) {
    const userId = interaction.user?.id;

    const session = new LiarsBarGame({
        initiatorId: userId,
        channel: interaction.channel,
        guild: interaction.guild,
    });
    session.onGameStarted = onGameStarted;

    const created = gameManager.createGame(session);
    if (!created.ok) {
        await interaction.reply({
            content: created.reason === 'player'
                ? '你已经在另一场游戏里了。'
                : '这个频道已经有一场游戏在进行中。',
            flags: MessageFlags.Ephemeral,
        });
        return false;
    }
    Object.setPrototypeOf(created.game, LiarsBarGame.prototype);
    const game = created.game;
    attachLiarsBarShutdown(game);
    game.onMemberInvalidated = async invalidMember => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId) {
            await handleLiarsBarMemberInvalidated(game, invalidUserId);
        }
    };

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
        logDiscordFailure(game, 'defer-start', error, userId);
        await cleanup(game);
        return false;
    }

    let okOpen = false;
    try {
        okOpen = await game.open();
    } catch (error) {
        okOpen = false;
        logDiscordFailure(game, 'open', error, userId);
    }
    if (!okOpen) {
        await cleanup(game);
        try {
            await interaction.editReply({ content: '我没有权限在这里发送游戏面板。' });
        } catch (error) {
            logDiscordFailure(game, 'open-failure-reply', error, userId);
        }
        return false;
    }
    await interaction.editReply({
        content: `🍸 桌子摆好了（${MIN_PLAYERS}-${MAX_PLAYERS} 人），等客人上桌……`,
    });
    return true;
}

// open 已在类内定义（发第一张招募面板）。

// ── 交互分发 ──────────────────────────────────────────────────────────────────

function parseParts(parts) {
    const input = (Array.isArray(parts) ? parts : [parts]).filter(part => typeof part === 'string');
    const tokens = input.flatMap(part => part.split(':')).filter(Boolean);
    if (tokens[0]?.startsWith('mystery_liars_bar_')) {
        tokens[0] = tokens[0].slice('mystery_liars_bar_'.length);
    }
    while (tokens[0] === 'mystery' || tokens[0] === 'liars' || tokens[0] === 'bar') tokens.shift();
    return {
        action: tokens[0],
        gameId: tokens[1],
        turnToken: tokens[2],
        argument: tokens[3],
    };
}

function sanitizeRenameNickname(raw) {
    return String(raw ?? '')
        .replace(/[@#:`*_~|>\\\x00-\x1F\x7F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 32);
}

async function handleRenameModalSubmit(interaction) {
    const parts = String(interaction.customId || '').split(':');
    const gameId = parts[1];
    const game = gameId && gameManager.getGame(gameId);
    if (!game || game.type !== 'liars_bar') {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(interaction, EXPIRED_MESSAGE);
        return false;
    }
    const raw = interaction.fields?.getTextInputValue?.('liars_bar_rename_input');
    const nickname = sanitizeRenameNickname(raw);
    if (!nickname) {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(interaction, '昵称不能为空，或包含 Discord 禁止的字符（@ # : 等）。');
        return false;
    }
    await game.chooseRenamePenalty(interaction, nickname);
    return true;
}

async function handleLiarsBarInteraction(interaction, parts) {
    if (interaction.isModalSubmit?.() && typeof interaction.customId === 'string'
        && interaction.customId.startsWith(RENAME_MODAL_PREFIX)) {
        return handleRenameModalSubmit(interaction);
    }
    const parsed = parseParts(parts);
    const game = parsed.gameId && gameManager.getGame(parsed.gameId);
    if (!game || game.type !== 'liars_bar') {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(interaction, EXPIRED_MESSAGE);
        return false;
    }
    const { action, turnToken } = parsed;
    switch (action) {
        case 'join':
            return game.join(interaction);
        case 'leave':
            return game.leaveRecruit(interaction);
        case 'start':
            return game.startByInitiator(interaction);
        case 'cancel':
            return game.cancelByInitiator(interaction);
        case 'play_card':
            return game.openPrivatePlay(interaction);
        case 'play_select':
            return game.playFromSelect(interaction, Number(turnToken));
        case 'confirm_play':
            return game.confirmPlay(interaction, Number(turnToken));
        case 'challenge':
            return game.act(interaction, 'challenge', Number(turnToken));
        case 'refresh':
            return game.refreshPanel(interaction);
        case 'item_help':
            return game.showItemHelp(interaction);
        case 'surrender':
            return game.surrender(interaction);
        case 'penalty_mute':
            return game.chooseMutePenalty(interaction);
        case 'penalty_rename':
            return game.openRenameModal(interaction);
        default:
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, EXPIRED_MESSAGE);
            return false;
    }
}

// refreshPanel 已在类内定义。

// ── 成员失格 ──────────────────────────────────────────────────────────────────

async function handleLiarsBarMemberInvalidated(game, userId) {
    if (!game || game.type !== 'liars_bar') return false;
    if (game.guild?.members?.cache?.has(userId)) return false;
    let outcome = null;
    await gameManager.runExclusive(game, () => {
        if (game.status === 'recruit') {
            if (!game.participants.includes(userId)) return;
            if (game.participants.length <= 1) {
                game.status = 'ended';
                game.lastEvent = '🧯 有人离开了酒馆，桌子散了。';
                outcome = 'invite_cancel';
                return;
            }
            gameManager.removePlayer(game, userId);
            game.participants = game.participants.filter(p => p !== userId);
            game.participantIds = [...game.participants];
            outcome = 'recruit_left';
            return;
        }
        if (game.status === 'penalty' && game.state
            && game.state.players.includes(userId) && game.state.alive.has(userId)) {
            // 惩罚结算窗口内的失格先记录：结算恢复后由 resumeAfterPenaltyLocked 补判。
            // （gameManager 对同一用户只派发一次，这里不接住就永久漏判。）
            game.pendingInvalidations ||= new Set();
            game.pendingInvalidations.add(userId);
            outcome = 'deferred';
            return;
        }
        if (game.status === 'playing' && game.state
            && game.state.players.includes(userId) && game.state.alive.has(userId)) {
            const result = game.state.applyForfeit(userId);
            game.lastEvent = `🏳️ **${game.shortName(userId)}** 从酒馆消失了，判负离席。\n${flavor('surrender')}`;
            game.panelColor = 0x9B59B6;
            // 无论是否终局：每个出局者都当场惩罚一次（终局时决定人=唯一存活者即胜者）。
            outcome = 'forfeit_penalty';
        }
    });
    if (!outcome) return false;
    if (outcome === 'deferred') return true; // 惩罚结束后由 resumeAfterPenaltyLocked 补判
    // 招募期失格/散桌没有对局状态可惩罚：刷新面板收场即可。
    // （原路径无条件走惩罚流，state 为 null 时 TypeError 会被兜底成整桌强制清场。）
    if (outcome !== 'forfeit_penalty') {
        await game.refreshMainPanelLocked();
        return true;
    }
    await game.sendBroadcastLocked({ title: '🏳️ 玩家失格' });
    // 受罚人就是本次失格者本人；按"第一个死者"找会罚到早已受罚的旧出局者。
    await game.beginEliminationPenaltyLocked(userId, 'surrender');
    return true;
}

// ── 重启中止 ──────────────────────────────────────────────────────────────────

function cleanup(game) {
    if (!game || game.released) return Promise.resolve();
    game.released = true;
    game.status = 'ended';
    game.cancelTimerLocked();
    game.disableAllComponents();
    game.deletePersisted?.();
    return gameManager.cleanupGame(game);
}

function attachLiarsBarShutdown(game) {
    game.onShutdown = async () => {
        game.cancelTimerLocked?.();
        for (const entry of [...(game.panels || [])]) {
            const msg = entry?.message;
            if (!msg || typeof msg.delete !== 'function') continue;
            await msg.delete().catch(error => logDiscordFailure(game, 'shutdown-delete-panel', error));
        }
        game.panels = [];
        try {
            await resumeStore.flush();
        } catch (error) {
            logDiscordFailure(null, 'resume-flush', error);
        }
    };
    return game;
}

// 启动时把上次没打完的骗子酒馆对局接回来（断连接续）。
async function restoreActiveGames(client) {
    let snapshots = [];
    try {
        snapshots = await resumeStore.list();
    } catch (error) {
        logDiscordFailure(null, 'resume-list', error);
        return 0;
    }
    let restored = 0;
    for (const snap of snapshots) {
        try {
            if (!snap || snap.v !== 1 || !snap.id || !snap.guildId || !snap.channelId) continue;
            if (gameManager.getGame(snap.id)) continue;
            const guild = client.guilds?.cache?.get(snap.guildId)
                || await client.guilds.fetch(snap.guildId).catch(() => null);
            if (!guild) {
                resumeStore.remove(snap.id);
                continue;
            }
            const channel = guild.channels?.cache?.get(snap.channelId)
                || await guild.channels.fetch(snap.channelId).catch(() => null);
            if (!channel || typeof channel.send !== 'function') {
                resumeStore.remove(snap.id);
                continue;
            }
            const game = LiarsBarGame.restore(snap, { guild, channel });
            const reg = gameManager.createGame(game);
            if (!reg.ok) continue;
            Object.setPrototypeOf(reg.game, LiarsBarGame.prototype);
            const restoredGame = reg.game;
            restoredGame.onMemberInvalidated = async invalidMember => {
                const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
                if (invalidUserId) await handleLiarsBarMemberInvalidated(restoredGame, invalidUserId);
            };
            attachLiarsBarShutdown(restoredGame);
            for (const pid of restoredGame.participants) {
                if (!pid) continue;
                await guild.members.fetch(pid).catch(() => {});
            }
            for (const msgId of Array.isArray(snap.panelIds) ? snap.panelIds : []) {
                if (!msgId) continue;
                await channel.messages.delete(msgId).catch(() => {});
            }
            await restoredGame.renderLocked();
            restored += 1;
        } catch (error) {
            logDiscordFailure(null, 'resume-restore', error, snap?.id);
        }
    }
    if (restored > 0) {
        console.log(`[LiarsBar] 断连接续：恢复 ${restored} 场未完成的对局。`);
    }
    return restored;
}

module.exports = {
    startLiarsBar,
    handleLiarsBarInteraction,
    restoreActiveGames,
    RENAME_MODAL_PREFIX,
};
