const { MessageFlags } = require('discord.js');
const gameManager = require('./mysteryGameManager');
const { handleRouletteInteraction } = require('./rouletteGame');
const { handleBombInteraction } = require('./bombGame');
const { handleDuelInteraction } = require('./duelGame');
const {
    handleDevilRouletteInteraction,
    RENAME_MODAL_PREFIX: DEVIL_ROULETTE_RENAME_MODAL_PREFIX,
} = require('./devilRouletteGame');
const {
    defaultService: duelPunishmentService,
    PUNISHMENT_CUSTOM_ID_PREFIX,
    RENAME_MODAL_CUSTOM_ID_PREFIX,
} = require('./duelPunishment');
const {
    CUSTOM_ID_PREFIX: PRESSURE_CUSTOM_ID_PREFIX,
    handlePressureInteraction,
} = require('./pressureRouletteGame');
const {
    handleLiarsBarInteraction,
    RENAME_MODAL_PREFIX: LIARS_BAR_RENAME_MODAL_PREFIX,
} = require('./liarsBarGame');
const {
    handleLiarsDiceInteraction,
    RENAME_MODAL_PREFIX: LIARS_DICE_RENAME_MODAL_PREFIX,
} = require('./liarsDiceGame');
const {
    CHANNEL_ACCESS_CUSTOM_ID_PREFIX,
    CHANNEL_ACCESS_MODAL_ID_PREFIX,
    handleChannelAccessInteraction,
} = require('./channelAccessManager');

const MYSTERY_CUSTOM_ID_PREFIX = 'mystery_';
const EXPIRED_INTERACTION_MESSAGE = '⌛ **这次游戏交互已经过期或失效了。**';
const FAILED_INTERACTION_MESSAGE = '❌ **处理这次游戏操作时出了点问题，请稍后再试。**';
const SIMPLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const ROUTES = Object.freeze({
    roulette: {
        join: { component: 'button', partCount: 2 },
        stop: { component: 'button', partCount: 3 },
        continue: { component: 'button', partCount: 3 },
    },
    bomb: {
        join: { component: 'button', partCount: 2 },
        pass: { component: 'button', partCount: 3, tokenIndex: 2 },
        defuse: { component: 'button', partCount: 3, tokenIndex: 2 },
        target: { component: 'string', partCount: 3, tokenIndex: 2 },
        defuse_target: { component: 'string', partCount: 3, tokenIndex: 2 },
    },
    duel: {
        accept: { component: 'button', partCount: 2 },
        reject: { component: 'button', partCount: 2 },
        cancel: { component: 'button', partCount: 2 },
        choice: { component: 'button', partCount: 4 },
    },
    devil_roulette: {
        accept: { component: 'button', partCount: 2 },
        decline: { component: 'button', partCount: 2 },
        cancel: { component: 'button', partCount: 2 },
        turn_hint: { component: 'button', partCount: 3 },
        refresh: { component: 'button', partCount: 2 },
        shoot: { component: 'button', partCount: 4 },
        item: { component: 'button', partCount: 5 },
        phone_blocked: { component: 'button', partCount: 5 },
        adrenaline: { component: 'string', partCount: 3, tokenIndex: 2 },
        intel: { component: 'button', partCount: 3 },
        item_help: { component: 'button', partCount: 3 },
        surrender: { component: 'button', partCount: 2 },
        penalty_mute: { component: 'button', partCount: 2 },
        penalty_rename: { component: 'button', partCount: 2 },
    },
    liars_bar: {
        join: { component: 'button', partCount: 2 },
        leave: { component: 'button', partCount: 2 },
        start: { component: 'button', partCount: 2 },
        cancel: { component: 'button', partCount: 2 },
        play_card: { component: 'button', partCount: 3, tokenIndex: 2 },
        play_select: { component: 'string', partCount: 3, tokenIndex: 2 },
        confirm_play: { component: 'button', partCount: 3, tokenIndex: 2 },
        challenge: { component: 'button', partCount: 3, tokenIndex: 2 },
        refresh: { component: 'button', partCount: 2 },
        item_help: { component: 'button', partCount: 3 },
        surrender: { component: 'button', partCount: 2 },
        penalty_mute: { component: 'button', partCount: 2 },
        penalty_rename: { component: 'button', partCount: 2 },
    },
    liars_dice: {
        join: { component: 'button', partCount: 2 },
        leave: { component: 'button', partCount: 2 },
        start: { component: 'button', partCount: 2 },
        cancel: { component: 'button', partCount: 2 },
        bid: { component: 'button', partCount: 3, tokenIndex: 2 },
        bid_count: { component: 'string', partCount: 3, tokenIndex: 2 },
        bid_face: { component: 'string', partCount: 3, tokenIndex: 2 },
        bid_confirm: { component: 'button', partCount: 3, tokenIndex: 2 },
        open: { component: 'button', partCount: 3, tokenIndex: 2 },
        spot_on: { component: 'button', partCount: 3, tokenIndex: 2 },
        spot_on_go: { component: 'button', partCount: 3, tokenIndex: 2 },
        look_dice: { component: 'button', partCount: 3 },
        refresh: { component: 'button', partCount: 2 },
        item_help: { component: 'button', partCount: 3 },
        surrender: { component: 'button', partCount: 2 },
        penalty_mute: { component: 'button', partCount: 2 },
        penalty_rename: { component: 'button', partCount: 2 },
    },
});

const DOWNSTREAM_HANDLERS = Object.freeze({
    roulette: handleRouletteInteraction,
    bomb: handleBombInteraction,
    duel: handleDuelInteraction,
    devil_roulette: handleDevilRouletteInteraction,
    liars_bar: handleLiarsBarInteraction,
    liars_dice: handleLiarsDiceInteraction,
});

function componentKind(interaction) {
    if (interaction?.isButton?.()) return 'button';
    if (interaction?.isStringSelectMenu?.()) return 'string';
    return null;
}

function parseMysteryCustomId(customId, kind) {
    if (typeof customId !== 'string' || !customId.startsWith(MYSTERY_CUSTOM_ID_PREFIX)) {
        return null;
    }

    const parts = customId.split(':');
    const routeMatch = /^mystery_(roulette|bomb|duel|devil_roulette|liars_bar|liars_dice)_([a-z_]+)$/.exec(parts[0]);
    if (!routeMatch) return { valid: false, parts };

    const [, type, action] = routeMatch;
    const route = ROUTES[type]?.[action];
    const gameId = parts[1];
    if (
        !route
        || route.component !== kind
        || parts.length !== route.partCount
        || !SIMPLE_ID_PATTERN.test(gameId || '')
    ) {
        return { valid: false, type, action, gameId, parts };
    }

    if (route.tokenIndex !== undefined && !/^\d+$/.test(parts[route.tokenIndex])) {
        return { valid: false, type, action, gameId, parts };
    }
    if (type === 'duel' && action === 'choice') {
        if (!SIMPLE_ID_PATTERN.test(parts[2] || '') || !['rock', 'scissors', 'paper'].includes(parts[3])) {
            return { valid: false, type, action, gameId, parts };
        }
    }

    return { valid: true, type, action, gameId, parts };
}

function logHandlerError(parsed, interaction, phase, error) {
    const context = [
        `type=${parsed?.type || 'unknown'}`,
        `action=${parsed?.action || 'unknown'}`,
        `game=${parsed?.gameId || 'unknown'}`,
        `user=${interaction?.user?.id || 'unknown'}`,
        `phase=${phase}`,
    ].join(' ');
    console.error(`[MysteryInteraction] ${context}`, error);
}

async function safePrivateResponse(interaction, content, parsed, phase) {
    try {
        if (interaction.deferred && !interaction.replied && typeof interaction.editReply === 'function') {
            await interaction.editReply({ content });
        } else if (interaction.replied && typeof interaction.followUp === 'function') {
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else if (!interaction.deferred && !interaction.replied && typeof interaction.reply === 'function') {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        } else {
            return false;
        }
        return true;
    } catch (error) {
        logHandlerError(parsed, interaction, phase, error);
        return false;
    }
}

async function handleMysteryInteraction(interaction) {
    if (typeof interaction?.customId !== 'string') return false;
    if (
        interaction.customId.startsWith(CHANNEL_ACCESS_CUSTOM_ID_PREFIX)
        || interaction.customId.startsWith(CHANNEL_ACCESS_MODAL_ID_PREFIX)
    ) {
        return handleChannelAccessInteraction(interaction);
    }

    // 死斗裁决会话不注册在 gameManager，必须走独立路由（含 rename modal 提交）。
    if (interaction.customId.startsWith(PUNISHMENT_CUSTOM_ID_PREFIX)) {
        return duelPunishmentService.handleInteraction(interaction);
    }
    if (interaction.isModalSubmit?.() && interaction.customId.startsWith(RENAME_MODAL_CUSTOM_ID_PREFIX)) {
        return duelPunishmentService.handleInteraction(interaction);
    }

    // 恶魔轮盘改名惩罚 Modal（胜者自定义败者昵称，走新游戏实例内的惩罚流）。
    if (interaction.isModalSubmit?.() && interaction.customId.startsWith(DEVIL_ROULETTE_RENAME_MODAL_PREFIX)) {
        return handleDevilRouletteInteraction(interaction, null);
    }

    // 骗子酒馆改名惩罚 Modal（惩罚决定人自定义出局者昵称）。
    if (interaction.isModalSubmit?.() && interaction.customId.startsWith(LIARS_BAR_RENAME_MODAL_PREFIX)) {
        return handleLiarsBarInteraction(interaction, null);
    }

    // 骗子骰子改名惩罚 Modal。
    if (interaction.isModalSubmit?.() && interaction.customId.startsWith(LIARS_DICE_RENAME_MODAL_PREFIX)) {
        return handleLiarsDiceInteraction(interaction, null);
    }

    const kind = componentKind(interaction);
    if (!kind || !interaction.customId.startsWith(MYSTERY_CUSTOM_ID_PREFIX)) return false;

    // 加压俄罗斯轮盘自带解析与校验，直接短路，不走下面的路由表。
    if (interaction.customId.startsWith(PRESSURE_CUSTOM_ID_PREFIX)) {
        return handlePressureInteraction(interaction);
    }

    let parsed;
    try {
        parsed = parseMysteryCustomId(interaction.customId, kind);
        const game = parsed?.valid && gameManager.getGame(parsed.gameId);
        if (!parsed?.valid || !game || game.type !== parsed.type) {
            await safePrivateResponse(
                interaction,
                EXPIRED_INTERACTION_MESSAGE,
                parsed,
                'expired-response'
            );
            return true;
        }

        await DOWNSTREAM_HANDLERS[parsed.type](interaction, parsed.parts);
        return true;
    } catch (error) {
        logHandlerError(parsed, interaction, 'route', error);
        await safePrivateResponse(
            interaction,
            FAILED_INTERACTION_MESSAGE,
            parsed,
            'failure-response'
        );
        return false;
    }
}

module.exports = {
    MYSTERY_CUSTOM_ID_PREFIX,
    handleMysteryInteraction,
};
