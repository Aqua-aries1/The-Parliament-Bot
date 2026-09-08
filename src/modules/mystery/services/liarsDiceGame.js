/**
 * 骗子骰子交互层（2-4 人公开招募，Liar's Dice 模式）。
 *
 * 与骗子酒馆（卡牌）同一套骨架：招募面板 → 主面板（叫点/开牌）→ 播报 →
 * 出局惩罚（禁言/改名，口径同酒馆）→ 终局；断点续传同模式。
 *
 * 差异点：
 *   - 叫点走两段式：主面板「🎲 叫点/加注」按钮 → ephemeral 私密面板
 *     （数量选择菜单 → 点数选择菜单 → ✅ 确认叫点；已选状态原地更新）；
 *   - 骰子每轮暗掷，ephemeral 面板查看自己的骰子；
 *   - 惩罚是确定性的：开牌输家失 1 骰，骰子归零出局（无左轮 RNG）。
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
const resumeStore = require('../utils/liarsDiceResumeStore');
const {
    LiarsDiceState,
    InvalidAction,
    defaultRng,
    DICE_SIDES,
    MIN_FACE,
    START_DICE_BY_PLAYERS,
    DEFAULT_START_DICE,
} = require('../core/liarsDiceEngine');

// ── 常量 ────────────────────────────────────────────────────────────────────

const RECRUIT_SECONDS = 120;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;
const TURN_SECONDS = 60;
const GRACE_SECONDS = 2;
const EPHEMERAL_TTL_MS = (TURN_SECONDS + GRACE_SECONDS + 30) * 1000;
const PANEL_HISTORY_LIMIT = 3;
const ITEM_HELP_LABEL = '📖 游戏规则';
const PENALTY_MUTE_MINUTES = 4;
const PENALTY_RENAME_MINUTES = 8;
const PENALTY_AUTO_MUTE_MINUTES = 4;
const PENALTY_SETTLEMENT_SECONDS = 60;
const SURRENDER_MUTE_MINUTES = 3;
const SURRENDER_RENAME_MINUTES = 6;
const PENALTY_NICKNAME = '🎲 骗子骰子输家';
const PENALTY_MUTE_REASON = '骗子骰子：出局惩罚';
const PENALTY_RENAME_APPLY_REASON = '骗子骰子：出局强制改名';
const PENALTY_RENAME_RESTORE_REASON = '骗子骰子：改名惩罚到期，恢复原昵称';
const PENALTY_RENAME_ENFORCE_REASON = '骗子骰子：出局强制改名';
const RENAME_LOCK_TYPE = 'liars_dice_rename';
const RENAME_MODAL_PREFIX = 'mystery_liars_dice_rename_modal';

const FACE_DOTS = { 1: '⚀', 2: '⚁', 3: '⚂', 4: '⚃', 5: '⚄', 6: '⚅' };

const EXPIRED_MESSAGE = '这局已经结束了。';
const NOT_YOUR_TURN_MESSAGE = '现在还没轮到你。';
const ACT_FAILED_MESSAGE = '操作失败，请重试或刷新面板。';

// ── 基础工具 ──────────────────────────────────────────────────────────────────

function logDiscordFailure(game, action, error, userId = 'system') {
    console.error(
        `[MysteryLiarsDice] Discord API 失败 (guild=${game?.guildId || 'unknown'}, game=${game?.id || 'unknown'}, user=${userId}, action=${action}):`,
        error
    );
}

function mention(userId) {
    if (userId == null) return '（无人）';
    return `<@${userId}>`;
}

function diceFace(face) {
    return `${FACE_DOTS[face] || ''} ${face}`;
}

function bidText(bid) {
    if (bid == null) return '—';
    return `**${bid.count} 个 ${diceFace(bid.face)}**`;
}

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

class LiarsDiceGame {
    constructor({ initiatorId, channel, guild, rng = null }) {
        this.type = 'liars_dice';
        this.id = randomUUID().toString().replace(/-/g, '').slice(0, 12);
        this.initiatorId = initiatorId;
        this.channel = channel;
        this.guild = guild;
        this.guildId = guild?.id || null;
        this.channelId = channel?.id || null;
        this.participants = [initiatorId];
        this.participantIds = [initiatorId];

        this.status = 'recruit'; // recruit / playing / penalty / ended
        this.state = null;
        this.rng = rng || null;

        this.panels = [];
        this.timers = new Set();
        this.turnTimer = null;
        this.lastEvent = '';
        this.finalWinnerId = null;

        this.penaltyPending = false;
        this.penaltyApplied = false;
        this.penaltyLoserId = null;
        this.penaltyDeciderId = null;
        this.penaltyScope = 'normal';
        this.settlementArmed = false;

        this.mainPanelSent = false;
        this.resumed = false;
        this.panelColor = 0x11806A;
        this.released = false;
        this.announcedPlayer = null;
        this.pingCurrentTurn = false;
        this.pendingAnnouncement = '';
        this.turnStartedAt = Date.now();
        // 两段式叫点登记：{ userId, turnToken, count, face }（face 未选时为 null）。
        this.pendingBid = null;
        // 出局惩罚队列：spot_on 命中多人同时归零时依次结算。
        this.penaltyQueue = [];
        // 本轮叫点史（加注螺旋轨迹，面板显示近几手）。
        this.bidHistory = [];
    }

    // ── 派生 ──

    get title() {
        return '🎲 骗子骰子';
    }

    shortName(userId) {
        return mention(userId);
    }

    plainName(userId) {
        const member = this.guild?.members?.cache?.get(userId);
        const name = member?.displayName;
        if (name) return name;
        this.guild?.members?.fetch?.(userId)?.catch?.(() => {});
        return `玩家${userId}`;
    }

    modeText() {
        return `${MIN_PLAYERS}-${MAX_PLAYERS} 人 · 叫点吹牛`;
    }

    // 本局起手骰数（按开局人数）。
    startDiceCount() {
        return this.state
            ? Math.max(...Object.values(this.state.dice).map(d => d.length)) || DEFAULT_START_DICE
            : (START_DICE_BY_PLAYERS[this.participants.length] ?? DEFAULT_START_DICE);
    }
    openingEvent() {
        const state = this.state;
        if (!state) return '';
        const lines = [`🎲 全场共 ${state.totalDice()} 颗骰子，各自暗掷完毕。`];
        const current = state.currentPlayerId;
        if (current != null) lines.push(`先手：**${this.shortName(current)}**。`);
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
            penaltyQueue: this.penaltyQueue,
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
        const game = new LiarsDiceGame({
            initiatorId: snapshot.initiatorId,
            channel,
            guild,
        });
        game.id = snapshot.id;
        game.status = snapshot.status;
        game.lastEvent = snapshot.lastEvent || '';
        game.panelColor = snapshot.panelColor || 0x11806A;
        game.finalWinnerId = snapshot.finalWinnerId || null;
        game.penaltyPending = !!snapshot.penaltyPending;
        game.penaltyApplied = !!snapshot.penaltyApplied;
        game.penaltyLoserId = snapshot.penaltyLoserId || null;
        game.penaltyDeciderId = snapshot.penaltyDeciderId || null;
        game.penaltyScope = snapshot.penaltyScope === 'surrender' ? 'surrender' : 'normal';
        game.pendingAnnouncement = snapshot.pendingAnnouncement || '';
        game.penaltyQueue = Array.isArray(snapshot.penaltyQueue) ? [...snapshot.penaltyQueue] : [];
        game.settlementArmed = false;
        game.participants = Array.isArray(snapshot.participants) ? [...snapshot.participants] : game.participants;
        game.participantIds = [...game.participants];
        game.state = snapshot.state ? LiarsDiceState.restore(snapshot.state) : null;
        game.resumed = true;
        return game;
    }

    async open() {
        return await this.renderLocked();
    }

    // ── 招募（与酒馆同构） ──

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
            this.lastEvent = `🎲 骰子入杯，一掷定音。\n${this.openingEvent()}`;
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
        await this.sendBroadcastLocked({ title: '🎲 开局掷骰' });
        await this.renderLocked();
        try {
            this.onGameStarted?.([this.initiatorId]);
        } catch (error) {
            logDiscordFailure(this, 'on-game-started', error, this.initiatorId);
        }
        await confirmComponent(interaction, '🎲 骰子已掷下。祝各位「诚实」。');
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

    async act(interaction, action, expectedToken, { bid = null } = {}) {
        if (!await deferComponent(interaction, { ephemeral: false })) return;
        let result = null;
        let rejection = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) {
                rejection = EXPIRED_MESSAGE;
                return;
            }
            if (interaction.user?.id !== this.state.currentPlayerId) {
                rejection = NOT_YOUR_TURN_MESSAGE;
                return;
            }
            try {
                result = this.state.apply(action, interaction.user.id, { expectedToken, bid });
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

    async afterActionLocked(result) {
        this.lastEvent = this.safeFormatResult(result);
        this.panelColor = this.resultColor(result);
        if (result.action === 'bid') {
            const seconds = this.turnStartedAt
                ? Math.max(0, Math.round((Date.now() - this.turnStartedAt) / 1000)) : null;
            const pace = seconds == null ? '' : seconds <= 5 ? `（秒叫 · ${seconds}s）` : seconds >= 40 ? `（犹豫很久 · ${seconds}s）` : `（${seconds}s）`;
            this.turnStartedAt = Date.now();
            this.bidHistory.push({ playerId: result.actorId, count: result.bid.count, face: result.bid.face });
            await this.sendBroadcastLocked({
                title: `🎲 ${this.plainName(result.actorId)} 叫 ${result.bid.count} 个 ${result.bid.face} ${pace}`,
            });
            await this.renderLocked();
            return;
        }
        if (result.action === 'open' || result.action === 'spot_on') {
            this.turnStartedAt = Date.now();
            this.bidHistory = []; // 开牌收尾，新一轮轨迹重新开始
            await this.sendBroadcastLocked({ title: result.action === 'spot_on' ? '🎯 精准开牌！' : '🎲 开牌！' });
            const eliminated = result.eliminatedIds?.length ? result.eliminatedIds : [];
            if (eliminated.length > 0) {
                // 惩罚队列：多人同时归零时依次结算（每个出局者都当场受罚一次）。
                this.penaltyQueue = eliminated.map(pid => {
                    let deciderId;
                    if (result.gameEnded) {
                        deciderId = result.winnerId;
                    } else if (result.action === 'spot_on') {
                        deciderId = result.spotOn ? result.actorId : result.calledBid.playerId;
                    } else {
                        deciderId = result.actorId === pid ? result.calledBid.playerId : result.actorId;
                    }
                    // 决定人若已出局（如开的是离席者留下的叫点），交给座位顺位兜底。
                    if (deciderId != null && !this.state.alive.has(deciderId)) deciderId = null;
                    return { loserId: pid, deciderId };
                });
                const first = this.penaltyQueue.shift();
                await this.beginEliminationPenaltyLocked(first.loserId, 'normal', first.deciderId);
            } else {
                await this.sendBroadcastLocked({ title: '🎲 新一轮掷骰' });
                await this.renderLocked();
            }
            return;
        }
        await this.renderLocked();
    }

    // ── 出局惩罚（与酒馆同构） ──

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
        this.status = 'penalty';
        await this.renderLocked();
    }

    async resumeAfterPenaltyLocked() {
        const state = this.state;
        if (!state) return;
        // 惩罚队列还有下一个出局者：继续结算（多人同时归零的场景）。
        // 与 phase 解耦：spot_on 命中可让终局同批出局者排队——必须全部罚完再终局，
        // 否则最后一批出局者静默逃罚。
        if (Array.isArray(this.penaltyQueue) && this.penaltyQueue.length > 0) {
            const next = this.penaltyQueue.shift();
            if (this.pendingAnnouncement) {
                this.lastEvent = this.pendingAnnouncement;
                this.pendingAnnouncement = '';
                await this.sendBroadcastLocked({ title: '🔨 下一位出局者' });
            }
            await this.beginEliminationPenaltyLocked(next.loserId, 'normal', next.deciderId);
            return;
        }
        if (state.phase === 'ended') {
            this.status = 'ended';
            this.finalWinnerId = state.winnerId;
            await this.sendBroadcastLocked({ title: '🏆 终局' });
            await this.renderLocked();
            return;
        }
        this.status = 'playing';
        if (this.pendingAnnouncement) {
            this.lastEvent = this.pendingAnnouncement;
            this.pendingAnnouncement = '';
            await this.sendBroadcastLocked({ title: '🎲 继续牌局' });
        }
        await this.renderLocked();
    }

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
        this.lastEvent = `🏳️ **${this.shortName(result.eliminatedId)}** 认输离席。`;
        this.panelColor = 0x11806A;
        await this.sendBroadcastLocked({ title: '🏳️ 认输离席' });
        if (result.gameEnded) {
            await this.beginEliminationPenaltyLocked(result.eliminatedId, 'surrender', result.winnerId);
        } else {
            await this.beginEliminationPenaltyLocked(result.eliminatedId, 'surrender');
        }
        await confirmComponent(interaction, '🏳️ 你离开了酒馆。');
    }

    // ── 定时器（与酒馆同构） ──

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
            this.lastEvent = '⌛ 桌子空等了一场，骰子收杯。招募超时。';
            changed = true;
        });
        if (changed) await this.renderLocked();
    }

    // 回合超时：无人叫点的第一手 → 替 TA 叫最小合法点；已有叫点 → 替 TA 开牌
    // （加注空间随螺旋收紧，随机加注容易送掉局面；开牌是更保守的兜底）。
    async turnTimeout(armedToken) {
        let result = null;
        await gameManager.runExclusive(this, () => {
            if (this.status !== 'playing' || !this.state) return;
            if (this.state.turnToken !== armedToken) return;
            const state = this.state;
            const actorId = state.currentPlayerId;
            try {
                if (state.currentBid == null) {
                    result = state.apply('bid', actorId, { expectedToken: armedToken, bid: { count: 1, face: MIN_FACE } });
                } else {
                    result = state.apply('open', actorId, { expectedToken: armedToken });
                }
            } catch (error) {
                if (!(error instanceof InvalidAction)) throw error;
            }
        });
        if (result) {
            this.lastEvent = `${this.safeFormatResult(result)}\n（⏰ 超时自动行动）`;
            await this.afterActionLocked(result);
        } else {
            await this.armTimerLocked();
        }
    }

    startLocked() {
        this.status = 'playing';
        this.state = new LiarsDiceState(this.participants, {
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

    async armSettlementTimeoutLocked() {
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
            this.pendingAnnouncement += `\n${line}（决定人未选，自动施罚失败——仍可手动重试）`;
        } else {
            this.pendingAnnouncement += `\n${line}（决定人未选，自动禁言 ${PENALTY_AUTO_MUTE_MINUTES} 分钟）`;
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
            .setCustomId('liars_dice_rename_input')
            .setLabel('要给出局者改成的昵称（最多 32 字）')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(32)
            .setPlaceholder('例如：🎲 今晚的骗子');
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

    // ── 渲染（与酒馆同构骨架） ──

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
            if (this.status === 'playing' && this.state && current != null && !rows.length) {
                logDiscordFailure(this, 'rows-fallback', new Error('turn got empty rows'), current);
                finalRows = this.guaranteedTurnRows(this.state);
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
        if (this.status === 'playing' && this.state && this.pingCurrentTurn) {
            const current = this.state.currentPlayerId;
            if (current != null) pingIds.push(current);
        } else if (this.status === 'penalty' && this.penaltyPending && !this.penaltyApplied) {
            if (this.penaltyDeciderId != null) pingIds.push(this.penaltyDeciderId);
        }
        this.pingCurrentTurn = false;
        return { parse: [], users: pingIds, repliedUser: false };
    }

    async refreshPanel(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let rejection = null;
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
        // 刷新只重发面板，不重排回合计时器（防连点刷新无限拖延，同酒馆）。
        const ok = await this.renderLocked({ armTimer: false });
        await sendEphemeral(interaction, {
            content: ok ? '🔄 已刷新当前面板。' : '🔄 面板刷新失败，请稍后再试。',
        });
    }

    // ── 面板文案 ──

    recruitEmbed() {
        const embed = new EmbedBuilder()
            .setTitle('🎲 骗子骰子开张')
            .setColor(0x5865F2)
            .setAuthor({ name: `${this.title} · ${this.modeText()}` });
        const deadline = Math.floor(Date.now() / 1000) + RECRUIT_SECONDS;
        const seated = this.participants.map(p => mention(p)).join('　');
        embed.setDescription(
            `**${this.shortName(this.initiatorId)}** 摆开了一张骰子桌。\n\n`
            + '**规则一句话**：每人若干骰子暗掷（人越多骰越少），轮流叫点「全场至少有 X 个 Y」——每次必须叫得更狠；'
            + '不信就开牌数骰（1 是万能点），或喊「🎯 精准开牌」赌正好。输家失 1 骰，骰子输光出局。\n\n'
            + `🪑 已入座（${this.participants.length}/${MAX_PLAYERS}）：${seated}\n\n`
            + `🔨 每个出局者都当场受罚：决定人选 🔇 禁言 ${PENALTY_MUTE_MINUTES} 分 / ✏️ 改名 ${PENALTY_RENAME_MINUTES} 分；活到最后的唯一幸存者是胜者，不受罚。\n\n`
            + `⏳ <t:${deadline}:R> 后桌子自动收摊；发起人可随时点 **🎬 开局**（≥${MIN_PLAYERS} 人）。`
        );
        embed.setFooter({ text: '1（⚀）是万能点——开牌时它算任何点数，但它自己不能被叫。' });
        return embed;
    }

    recruitViewRows() {
        const row = new ActionRowBuilder();
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_join:${this.id}`)
                .setLabel('🪑 上桌')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_leave:${this.id}`)
                .setLabel('🚪 离桌')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_start:${this.id}`)
                .setLabel('🎬 发起人开局')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_cancel:${this.id}`)
                .setLabel('🛑 取消')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_item_help:${this.id}:${this.state?.turnToken ?? ''}`)
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
        const title = resumed ? '🔁 断连接续 · 🎲 叫点回合' : '🎲 叫点回合';
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
                parts.push(`# ⚡轮到 ${this.plainName(current)} ${state.currentBid != null ? '加注或开牌！' : '叫点！'}`);
            }
            parts.push(`⏳ <t:${Math.floor(Date.now() / 1000) + TURN_SECONDS + GRACE_SECONDS}:R> 超时${state.currentBid != null ? '自动开牌' : '自动叫点'}`);
            parts.push('');
        }
        parts.push(`**当前叫点：${bidText(state.currentBid)}**（全场 ${state.totalDice()} 颗骰）`);
        if (state.currentBid != null) {
            parts.push(`叫点人：${this.shortName(state.currentBid.playerId)}`);
        } else {
            parts.push('本轮尚未有人叫点——首叫任意（1 不可叫）。');
        }
        // 叫点史：加注螺旋是骰子博弈的核心推演素材（谁抬杠、抬到哪）。
        if (this.bidHistory && this.bidHistory.length) {
            const recent = this.bidHistory.slice(-3);
            parts.push(`叫点轨迹：${recent.map(h => `${this.plainName(h.playerId)}→${h.count}个${h.face}`).join('，')}`);
        }
        parts.push('', '');
        embed.setDescription(parts.join('\n'));

        const ordered = current != null
            ? [current, ...state.players.filter(p => p !== current)]
            : state.players;
        const rows = ordered.map(playerId => {
            const alive = state.alive.has(playerId);
            const mark = !alive ? '💀' : (playerId === current ? '▶️' : '·');
            return `${mark} ${mention(playerId)}　🎲 ${alive ? state.diceCount(playerId) : 0}`;
        });
        if (ordered.length > 4) {
            // 5-8 人局：单个紧凑区块（每人一行），避免 8 个独立 field 撑爆面板。
            embed.addFields([{ name: '🎲 玩家', value: rows.join('\n'), inline: false }]);
        } else {
            for (let idx = 0; idx < ordered.length; idx++) {
                const playerId = ordered[idx];
                const alive = state.alive.has(playerId);
                const fname = !alive ? '💀 已出局' : (playerId === current ? '▶️ 行动中' : '等待');
                embed.addFields([{ name: fname, value: `${mention(playerId)}　🎲 ${alive ? state.diceCount(playerId) : 0} 颗`, inline: false }]);
            }
        }
        return embed;
    }

    gameViewRows() {
        const state = this.state;
        if (!state) return [];
        const current = state.currentPlayerId;
        if (current == null) return [];

        try {
            const canBidMore = [...Array(DICE_SIDES - MIN_FACE + 1).keys()]
                .map(k => k + MIN_FACE)
                .some(f => state.isLegalBid(state.currentBid ? state.currentBid.count : 1, f)
                    || state.isLegalBid((state.currentBid ? state.currentBid.count : 0) + 1, f));

            const row0 = new ActionRowBuilder();
            const bidBtn = new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_bid:${this.id}:${state.turnToken}`)
                .setStyle(ButtonStyle.Primary);
            if (!canBidMore) {
                bidBtn.setLabel('🎲 叫点已达上限（请开牌）').setDisabled(true);
            } else {
                bidBtn.setLabel(`🎲 叫点/加注（@${this.plainName(current)}）`);
            }
            row0.addComponents(bidBtn);

            const openBtn = new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_open:${this.id}:${state.turnToken}`)
                .setLabel('🤥 开牌！')
                .setStyle(ButtonStyle.Danger);
            if (!state.canOpen(current)) openBtn.setDisabled(true); // 首叫前不可开牌
            row0.addComponents(openBtn);

            const spotBtn = new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_spot_on:${this.id}:${state.turnToken}`)
                .setStyle(ButtonStyle.Success);
            const canSpot = state.canSpotOn(current);
            if (!canSpot) {
                spotBtn.setDisabled(true);
                if (state.canOpen(current) && state.spotOnCooldown === current) {
                    spotBtn.setLabel('🎯 精准开牌（冷却中）');
                } else {
                    spotBtn.setLabel('🎯 精准开牌');
                }
            } else {
                spotBtn.setLabel('🎯 精准开牌');
            }
            row0.addComponents(spotBtn);
            const lastRow = new ActionRowBuilder();
            lastRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`mystery_liars_dice_look_dice:${this.id}:${state.turnToken}`)
                    .setLabel('🎯 看我的骰子')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`mystery_liars_dice_refresh:${this.id}`)
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
                .setCustomId(`mystery_liars_dice_bid:${this.id}:${state.turnToken}`)
                .setLabel('🎲 叫点/加注')
                .setStyle(ButtonStyle.Primary)
        );
        const lastRow = new ActionRowBuilder();
        this.addItemHelpButton(lastRow);
        return [row0, lastRow];
    }

    addItemHelpButton(row) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_item_help:${this.id}:${this.state?.turnToken ?? ''}`)
                .setLabel(ITEM_HELP_LABEL)
                .setStyle(ButtonStyle.Secondary)
        );
    }

    // ── 私密面板：看骰子 + 两段式叫点 ──

    async lookDice(interaction) {
        await deferComponent(interaction, { ephemeral: true });
        let rejection = null;
        let embed = null;
        await gameManager.runExclusive(this, () => {
            const state = this.state;
            if (this.status !== 'playing' || !state) {
                rejection = '这局还没开始或已经结束了。';
                return;
            }
            if (!state.players.includes(interaction.user?.id)) {
                rejection = '只有本局玩家可以看骰子。';
                return;
            }
            embed = this.diceEmbed(interaction.user.id);
        });
        if (rejection) {
            await sendComponentError(interaction, rejection);
            return;
        }
        const state = this.state;
        const isTurn = interaction.user?.id === state.currentPlayerId;
        await sendEphemeral(interaction, {
            embeds: [embed],
            components: isTurn ? this.bidViewRows(state, interaction.user.id) : [],
        });
    }

    diceEmbed(userId) {
        const state = this.state;
        const bid = state.currentBid;
        // 期望参考：自己真实相关骰 + 其他人骰 × 1/3（被叫面+万能 ⚀ 的期望占比）——新手友好。
        const face = bid?.face ?? 6;
        const mine = (state.dice[userId] || []).filter(f => f === face || f === 1).length;
        const others = state.totalDice() - state.diceCount(userId);
        const expect = mine + others / 3;
        const hint = bid != null
            ? `\n你手里与「${bid.count} 个 ${bid.face}」相关的骰子：${mine} 颗（含万能 ⚀）`
            : '';
        return new EmbedBuilder()
            .setTitle(`${this.title} · 仅你可见`)
            .setColor(0x5865F2)
            .setDescription(
                `当前叫点：${bidText(bid)}（全场 ${state.totalDice()} 颗骰）\n\n`
                + `**你的骰子**（${state.diceCount(userId)} 颗）：\n${state.diceText(userId)}${hint}\n\n`
                + `📊 参考：全场期望约 **${expect.toFixed(1)} 个 ${face}**`
                + (bid != null
                    ? `（当前叫 ${bid.count} 个${bid.count > expect ? '，偏激进——可考虑开牌' : ''}）`
                    : '（首叫别超过期望太多）')
            );
    }

    // 两段式叫牌：数量菜单 → 点数菜单 → 确认。三个组件同面板，
    // 每次选择后原地更新已选状态。
    bidViewRows(state, userId) {
        const rows = [];
        // 只认当前回合、本人登记的待确认叫点：跨回合残留/他人登记一律视为空，
        // 否则旧面板的选择会被渲染成"当前可确认"，误导性落子。
        const pending = this.pendingBid?.turnToken === state.turnToken && this.pendingBid?.userId === userId
            ? this.pendingBid
            : null;
        const prev = state.currentBid;
        const maxCount = state.totalDice();

        // 数量菜单：从合法最小数量到全场骰数。
        const minCount = prev == null ? 1 : prev.count; // 同数量 + 更大点数也合法
        const countOptions = [];
        for (let c = minCount; c <= maxCount; c++) {
            const legal = [...Array(DICE_SIDES - MIN_FACE + 1).keys()]
                .map(k => k + MIN_FACE)
                .some(f => state.isLegalBid(c, f));
            if (legal) countOptions.push(c);
        }
        // Discord 选择菜单上限 25 项：8 人局总量可达 40。超出时只保留
        // 「当前叫点数量 ±窗口」的邻近档位（远端档位实战中几乎不会叫）。
        const COUNT_MENU_LIMIT = 25;
        let shownCountOptions = countOptions;
        if (countOptions.length > COUNT_MENU_LIMIT) {
            const prevCount = state.currentBid?.count ?? minCount;
            const window = Math.floor((COUNT_MENU_LIMIT - 1) / 2);
            let start = Math.max(0, countOptions.indexOf(prevCount) - window);
            if (start + COUNT_MENU_LIMIT > countOptions.length) {
                start = countOptions.length - COUNT_MENU_LIMIT;
            }
            shownCountOptions = countOptions.slice(start, start + COUNT_MENU_LIMIT);
        }
        if (shownCountOptions.length) {
            const countMenu = new StringSelectMenuBuilder()
                .setCustomId(`mystery_liars_dice_bid_count:${this.id}:${state.turnToken}`)
                .setPlaceholder(pending?.count != null ? `数量已选：${pending.count}` : '① 选数量（几颗）')
                .addOptions(shownCountOptions.map(c => new StringSelectMenuOptionBuilder()
                    .setLabel(`${c} 个`)
                    .setValue(String(c))));
            rows.push(new ActionRowBuilder().addComponents(countMenu));
        } else {
            rows.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`mystery_liars_dice_bid_max:${this.id}`)
                    .setLabel('⚠️ 叫点已达全场上限，无法加注，请直接开牌')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            ));
        }

        // 点数菜单：仅当数量已选时可用（按该数量列出合法点数）。
        const count = pending?.count;
        const faces = count != null
            ? [...Array(DICE_SIDES - MIN_FACE + 1).keys()]
                .map(k => k + MIN_FACE)
                .filter(f => state.isLegalBid(count, f))
            : [];
        if (faces.length) {
            const faceMenu = new StringSelectMenuBuilder()
                .setCustomId(`mystery_liars_dice_bid_face:${this.id}:${state.turnToken}`)
                .setPlaceholder(pending?.face != null ? `点数已选：${pending.face}` : '② 选项数（1 不可叫）')
                .addOptions(faces.map(f => new StringSelectMenuOptionBuilder()
                    .setLabel(`${f} 点`)
                    .setValue(String(f))
                    .setDescription(`开牌时 ${f} 和万能 ⚀ 都计入`)));
            rows.push(new ActionRowBuilder().addComponents(faceMenu));
        } else {
            // 未选数量时不能渲染零选项选择菜单——Discord 对 select 的选项下限是 1，
            // 即使 disabled 也报 50035 Invalid Form Body（首手叫点面板卡死的根因）。用禁用按钮占位。
            rows.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`mystery_liars_dice_bid_face_wait:${this.id}`)
                    .setLabel('② 先选上方数量，再选项数')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            ));
        }

        // 确认按钮。
        const ready = count != null && pending?.face != null;
        const rowBtn = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_bid_confirm:${this.id}:${state.turnToken}`)
                .setLabel(ready ? `✅ 确认叫点：${count} 个 ${pending.face}` : '✅ 确认叫点')
                .setStyle(ButtonStyle.Success)
                .setDisabled(!ready)
        );
        rows.push(rowBtn);
        return rows;
    }

    // 数量选择：登记并原地更新。
    async bidCountSelect(interaction, expectedToken) {
        await deferComponent(interaction, { ephemeral: true });
        const count = Number(interaction.values?.[0]);
        const state = this.state;
        const userId = interaction.user?.id;
        if (this.status !== 'playing' || !state
            || userId !== state.currentPlayerId
            || state.turnToken !== expectedToken) {
            await sendComponentError(interaction, EXPIRED_MESSAGE);
            return;
        }
        this.pendingBid = { userId, turnToken: expectedToken, count, face: null };
        await sendEphemeral(interaction, {
            embeds: [this.diceEmbed(userId)],
            components: this.bidViewRows(state, userId),
        });
    }

    // 点数选择：登记并原地更新。
    async bidFaceSelect(interaction, expectedToken) {
        await deferComponent(interaction, { ephemeral: true });
        const face = Number(interaction.values?.[0]);
        const state = this.state;
        const userId = interaction.user?.id;
        if (this.status !== 'playing' || !state
            || userId !== state.currentPlayerId
            || state.turnToken !== expectedToken
            || !this.pendingBid || this.pendingBid.userId !== userId) {
            await sendComponentError(interaction, EXPIRED_MESSAGE);
            return;
        }
        this.pendingBid.face = face;
        await sendEphemeral(interaction, {
            embeds: [this.diceEmbed(userId)],
            components: this.bidViewRows(state, userId),
        });
    }

    // 确认叫点。
    async bidConfirm(interaction, expectedToken) {
        const pending = this.pendingBid;
        const userId = interaction.user?.id;
        const state = this.state;
        if (!pending || pending.userId !== userId || pending.face == null
            || this.status !== 'playing' || !state
            || state.turnToken !== expectedToken
            || pending.turnToken !== expectedToken) {
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '叫点未完成：请先选数量和点数。');
            return;
        }
        this.pendingBid = null;
        await this.act(interaction, 'bid', expectedToken, { bid: { count: pending.count, face: pending.face } });
    }

    // 精准开牌：高风险动作，先弹 ephemeral 确认（显示当前叫点与赔率提示）。
    async spotOnConfirm(interaction, expectedToken) {
        await deferComponent(interaction, { ephemeral: true });
        const state = this.state;
        const userId = interaction.user?.id;
        if (this.status !== 'playing' || !state || userId !== state.currentPlayerId
            || state.turnToken !== expectedToken || !state.canOpen(userId)) {
            await sendComponentError(interaction, EXPIRED_MESSAGE);
            return;
        }
        if (!state.canSpotOn(userId)) {
            await sendComponentError(interaction, '⏳ 你上一手精准开牌失手，本轮正在冷却中，只能普通叫点或开牌。');
            return;
        }
        const bid = state.currentBid;
        // 赔率提示：叫点数恰好等于实际数的先验（均匀骰面下二项分布峰值附近）。
        await sendEphemeral(interaction, {
            content: `🎯 精准开牌确认：你认定「**${bid.count} 个 ${bid.face}」正好就是实际数量**（含万能 ⚀）。\n`
                + '　✅ 正好 → **除你外全场各失 1 骰**（大赚）\n'
                + '　❌ 不正好 → 你自己失 1 骰\n'
                + '确定要拍吗？再点一次下方按钮确认。',
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`mystery_liars_dice_spot_on_go:${this.id}:${state.turnToken}`)
                    .setLabel(`🎯 确认：正好 ${bid.count} 个 ${bid.face}`)
                    .setStyle(ButtonStyle.Danger)
            )],
        });
    }

    // 精准开牌二次确认后真正执行。
    async spotOnGo(interaction, expectedToken) {
        const state = this.state;
        const userId = interaction.user?.id;
        if (!state || !state.canSpotOn(userId)) {
            await sendComponentError(interaction, '⏳ 当前不能精准开牌（可能已过期或处于冷却中）。');
            return;
        }
        await this.act(interaction, 'spot_on', expectedToken);
    }

    rulesEmbed() {
        return new EmbedBuilder()
            .setTitle('📖 游戏规则')
            .setColor(0x5865F2)
            .setAuthor({ name: `${this.title} · 仅你可见` })
            .setDescription(
                '**🎲 骰与叫点**\n'
                + `每人起手 ${this.startDiceCount()} 颗骰子（人越多骰越少，控制节奏），每轮暗掷（只有自己可见）。`
                + '轮流叫点：声称「全场至少有 X 个 Y 点」——每次叫点必须比上一手更狠：'
                + '数量更多，或同数量点数更大（1 不可叫）。\n\n'
                + '**🤥 开牌与精准开牌**\n'
                + '轮到你时可以开牌质疑上一手的叫点：全场数骰，被叫点数与万能 ⚀（1）都计入。\n'
                + '　• 数量**够** → 叫点成立，**开牌者**失 1 骰；\n'
                + '　• 数量**不够** → 叫点者吹牛，**叫点者**失 1 骰；\n'
                + '**🎯 精准开牌**：认定上一手「正好是实际数量」——'
                + '正好 → **除你外全场各失 1 骰**；不正好 → 你自己失 1 骰（**失手冷却一轮**）。\n\n'
                + '**🔫 出局**\n'
                + '骰子输光即出局，并由开牌赢家选择 🔇 禁言 4 分 / ✏️ 改名 8 分'
                + `（${PENALTY_SETTLEMENT_SECONDS} 秒不选自动禁言 4 分；认输/失格减轻为 3 / 6 分）。\n\n`
                + '**🏆 胜利**：仅剩 1 人存活即获胜，不受任何惩罚。\n\n'
                + `**⏱ 回合**：每回合 ${TURN_SECONDS} 秒；超时自动行动（首叫替你叫最小点，已有叫点则替你开牌）。\n\n`
                + '**⚠️ 与原版 Liar\'s Dice 的差异**：出局惩罚由「纯失骰」改为失骰出局后另附禁言/改名（对齐本 bot 其他游戏）。'
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
        const state = this.state;
        const isPlayer = state != null && userId != null
            && state.players.includes(userId) && state.alive.has(userId);
        const canSurrender = this.status === 'playing' && isPlayer;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_surrender:${this.id}`)
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
                `💀 出局者：${mention(this.penaltyLoserId)}　⚖️ 决定人：${mention(this.penaltyDeciderId)}${isFinal ? '（最后一罚，罚完即终局）' : ''}\n`
                + `🔨 **${mention(this.penaltyDeciderId)}，轮到你收利息**：`
                + `🔇 禁言 ${muteMin} 分钟，或 ✏️ 改名 ${renameMin} 分钟——点下方按钮。`
                + `${PENALTY_SETTLEMENT_SECONDS} 秒不选则自动禁言 ${PENALTY_AUTO_MUTE_MINUTES} 分钟。`
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
            let roster = '';
            if (state) {
                const eliminated = state.players.filter(p => !state.alive.has(p));
                if (eliminated.length > 0) {
                    roster = `\n\n💀 今晚离席的人：${eliminated.map(p => mention(p)).join('　')}`;
                }
            }
            parts.push(`# 🏆 ${mention(this.finalWinnerId)} 是今晚最后还握着骰子的人。${roster}`);
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
                .setCustomId(`mystery_liars_dice_penalty_mute:${this.id}`)
                .setLabel(`🔇 禁言 ${muteMin} 分钟`)
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`mystery_liars_dice_penalty_rename:${this.id}`)
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
        if (result.action === 'bid') {
            lines.push(`🎲 ${actor} 叫 ${bidText(result.bid)}。`);
        } else if (result.action === 'open' || result.action === 'spot_on') {
            const calledBid = result.calledBid || {};
            const parts = [];
            for (const [pid, faces] of Object.entries(result.revealedDice || {})) {
                parts.push(`${this.shortName(pid)}：${faces.join(' ')}`);
            }
            const verb = result.action === 'spot_on' ? '🎯 精准开牌' : '🤥 开牌';
            lines.push(`${verb}！${actor} 挑战「${calledBid.count} 个 ${calledBid.face}」——全场亮骰：`);
            lines.push(parts.join('\n'));
            if (result.action === 'spot_on') {
                lines.push(`实际 ${result.totalCalled} 个（含万能 ⚀）——${result.spotOn
                    ? `**正好！** 除 ${actor} 外全场各失 1 骰`
                    : `不是正好——${actor} 自己失 1 骰`}`);
            } else {
                lines.push(`实际 ${result.totalCalled} 个（含万能 ⚀）——${result.bidHolds ? `**叫点成立**，${actor} 失 1 骰` : `**吹牛成立**，${this.shortName(calledBid.playerId)} 失 1 骰`}`);
            }
            const outs = result.eliminatedIds?.length ? result.eliminatedIds : (result.eliminatedId ? [result.eliminatedId] : []);
            if (outs.length) {
                lines.push(`💀 **${outs.map(p => this.shortName(p)).join('、')} 骰子输光，出局`);
            }
            if (!result.gameEnded && result.newRound) {
                lines.push(`\n🎲 新一轮重新掷骰，先手 ${this.shortName(result.firstPlayerId)}。`);
            }
        } else if (result.action === 'forfeit') {
            lines.push(`🏳️ **${this.shortName(result.eliminatedId)}** 离开了牌桌。`);
        }
        return lines.join('\n');
    }

    resultColor(result) {
        if (result.gameEnded) return 0xF1C40F;
        if (result.action === 'open') return result.eliminatedId != null ? 0xE74C3C : 0xE67E22;
        return 0x11806A;
    }

    // ── 惩罚应用（对齐酒馆） ──

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

}

// ── 启动入口 ──────────────────────────────────────────────────────────────────

async function startLiarsDice(interaction, { onGameStarted } = {}) {
    const userId = interaction.user?.id;

    const session = new LiarsDiceGame({
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
    Object.setPrototypeOf(created.game, LiarsDiceGame.prototype);
    const game = created.game;
    attachLiarsDiceShutdown(game);
    game.onMemberInvalidated = async invalidMember => {
        const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
        if (invalidUserId) {
            await handleLiarsDiceMemberInvalidated(game, invalidUserId);
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
        content: `🎲 骰子桌摆好了（${MIN_PLAYERS}-${MAX_PLAYERS} 人），等客人上桌……`,
    });
    return true;
}

// open 已在类内定义。

// ── 交互分发 ──────────────────────────────────────────────────────────────────

function parseParts(parts) {
    const input = (Array.isArray(parts) ? parts : [parts]).filter(part => typeof part === 'string');
    const tokens = input.flatMap(part => part.split(':')).filter(Boolean);
    if (tokens[0]?.startsWith('mystery_liars_dice_')) {
        tokens[0] = tokens[0].slice('mystery_liars_dice_'.length);
    }
    while (tokens[0] === 'mystery' || tokens[0] === 'liars' || tokens[0] === 'dice') tokens.shift();
    return {
        action: tokens[0],
        gameId: tokens[1],
        turnToken: tokens[2],
        argument: tokens[3],
    };
}

function sanitizeRenameNickname(raw) {
    return String(raw ?? '')
        .replace(/[@#:\\\x00-\x1F\x7F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 32);
}

async function handleRenameModalSubmit(interaction) {
    const parts = String(interaction.customId || '').split(':');
    const gameId = parts[1];
    const game = gameId && gameManager.getGame(gameId);
    if (!game || game.type !== 'liars_dice') {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(interaction, EXPIRED_MESSAGE);
        return false;
    }
    const raw = interaction.fields?.getTextInputValue?.('liars_dice_rename_input');
    const nickname = sanitizeRenameNickname(raw);
    if (!nickname) {
        await deferComponent(interaction, { ephemeral: true });
        await sendComponentError(interaction, '昵称不能为空，或包含 Discord 禁止的字符（@ # : 等）。');
        return false;
    }
    await game.chooseRenamePenalty(interaction, nickname);
    return true;
}

async function handleLiarsDiceInteraction(interaction, parts) {
    if (interaction.isModalSubmit?.() && typeof interaction.customId === 'string'
        && interaction.customId.startsWith(RENAME_MODAL_PREFIX)) {
        return handleRenameModalSubmit(interaction);
    }
    const parsed = parseParts(parts);
    const game = parsed.gameId && gameManager.getGame(parsed.gameId);
    if (!game || game.type !== 'liars_dice') {
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
        case 'bid':
            return game.lookDice(interaction); // 主面板按钮 → 私密叫点面板（含看骰）
        case 'bid_face_wait':
        case 'bid_max':
            await deferComponent(interaction, { ephemeral: true });
            await sendComponentError(interaction, '此按钮仅为状态提示，请按提示操作。');
            return false;
        case 'bid_count':
            return game.bidCountSelect(interaction, Number(turnToken));
        case 'bid_face':
            return game.bidFaceSelect(interaction, Number(turnToken));
        case 'bid_confirm':
            return game.bidConfirm(interaction, Number(turnToken));
        case 'open':
            return game.act(interaction, 'open', Number(turnToken));
        case 'spot_on':
            return game.spotOnConfirm(interaction, Number(turnToken));
        case 'spot_on_go':
            return game.spotOnGo(interaction, Number(turnToken));
        case 'look_dice':
            return game.lookDice(interaction);
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

// ── 成员失格 ──────────────────────────────────────────────────────────────────

async function handleLiarsDiceMemberInvalidated(game, userId) {
    if (!game || game.type !== 'liars_dice') return false;
    if (game.guild?.members?.cache?.has(userId)) return false;
    let outcome = null;
    await gameManager.runExclusive(game, () => {
        if (game.status === 'recruit') {
            if (!game.participants.includes(userId)) return;
            if (game.participants.length <= 1) {
                game.status = 'ended';
                game.lastEvent = '🧯 有人离开了牌桌，桌子散了。';
                outcome = 'invite_cancel';
                return;
            }
            gameManager.removePlayer(game, userId);
            game.participants = game.participants.filter(p => p !== userId);
            game.participantIds = [...game.participants];
            outcome = 'recruit_left';
            return;
        }
        if (game.status === 'playing' && game.state
            && game.state.players.includes(userId) && game.state.alive.has(userId)) {
            game.state.applyForfeit(userId);
            game.lastEvent = `🏳️ **${game.shortName(userId)}** 从牌桌消失了，判负离席。`;
            game.panelColor = 0x11806A;
            outcome = 'forfeit_penalty';
        }
    });
    if (!outcome) return false;
    // 招募期失格/散桌没有对局状态可惩罚：刷新面板收场即可。
    // （state 为 null 时走惩罚流会在 state.players 处 TypeError。）
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

function attachLiarsDiceShutdown(game) {
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

// 启动时把上次没打完的骗子骰子对局接回来（断连接续）。
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
            const game = LiarsDiceGame.restore(snap, { guild, channel });
            const reg = gameManager.createGame(game);
            if (!reg.ok) continue;
            Object.setPrototypeOf(reg.game, LiarsDiceGame.prototype);
            const restoredGame = reg.game;
            restoredGame.onMemberInvalidated = async invalidMember => {
                const invalidUserId = invalidMember?.id || invalidMember?.user?.id;
                if (invalidUserId) await handleLiarsDiceMemberInvalidated(restoredGame, invalidUserId);
            };
            attachLiarsDiceShutdown(restoredGame);
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
        console.log(`[LiarsDice] 断连接续：恢复 ${restored} 场未完成的对局。`);
    }
    return restored;
}

module.exports = {
    startLiarsDice,
    handleLiarsDiceInteraction,
    restoreActiveGames,
    RENAME_MODAL_PREFIX,
};
