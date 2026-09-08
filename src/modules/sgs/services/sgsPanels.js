/**
 * 三国杀 Embed 面板与组件渲染（Discord.js v14，规范简体中文）。
 */

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
} = require('discord.js');

function formatEvent(event, nameOf) {
    const etype = event.type;
    if (etype === 'turn') return null;
    if (etype === 'draw') {
        const base = `**${nameOf(event.player_id)}** 摸了 ${event.count} 张牌`;
        return event.reason ? `${base}（${event.reason}）` : base;
    }
    if (etype === 'card_played') {
        const note = event.note ? ` ${event.note}` : '';
        return `**${nameOf(event.player_id)}** 打出 ${event.card_short}${note}`;
    }
    if (etype === 'equip') {
        const replaced = event.replaced_short ? `，替换 ${event.replaced_short}` : '';
        return `**${nameOf(event.player_id)}** 装备 ${event.card_short}（${event.slot}）${replaced}`;
    }
    if (etype === 'delayed_place') {
        return `**${nameOf(event.player_id)}** 将【${event.card_name}】置入 ${nameOf(event.target_id)} 的判定区`;
    }
    if (etype === 'attack') {
        if (event.pierce) {
            return `**${nameOf(event.attacker_id)}** 对 ${nameOf(event.target_id)} 使用 ${event.card_short}，无法以【闪】响应！`;
        }
        return `**${nameOf(event.attacker_id)}** 对 ${nameOf(event.target_id)} 使用 ${event.card_short}`;
    }
    if (etype === 'dodge') {
        const shown = event.card_short || '【闪】';
        const note = event.note ? ` ${event.note}` : '';
        return `**${nameOf(event.player_id)}** 打出 ${shown}${note}，避开了攻击`;
    }
    if (etype === 'attack_nullified') {
        return `${nameOf(event.player_id)} 的防具抵消了 ${event.card_short}`;
    }
    if (etype === 'nullify') {
        return `⚡ **${nameOf(event.player_id)}** 抢出 ${event.card_short}，抵消了【${event.trick_name}】！`;
    }
    if (etype === 'nullify_window') {
        return `⏳ 【${event.trick_name}】生效前，全场进入【无懈可击】抢断窗口（${event.seconds}秒）！`;
    }
    if (etype === 'damage') {
        const via = event.via ? `（${event.via}）` : '';
        return `**${nameOf(event.target_id)}** 受到 ${event.amount} 点伤害${via}，剩 ${event.hp}/${event.max_hp}`;
    }
    if (etype === 'lose_hp') {
        const reason = event.reason ? `（${event.reason}）` : '';
        return `**${nameOf(event.target_id)}** 失去 ${event.amount} 点体力${reason}，剩 ${event.hp}/${event.max_hp}`;
    }
    if (etype === 'heal') {
        const reason = event.reason ? `（${event.reason}）` : '';
        return `**${nameOf(event.target_id)}** 回复 ${event.amount} 点体力${reason}，剩 ${event.hp}/${event.max_hp}`;
    }
    if (etype === 'death') {
        return `☠️ **${nameOf(event.player_id)}** 阵亡，身份是【${event.role}】`;
    }
    if (etype === 'skill') {
        const note = event.note ? `，${event.note}` : '';
        return `✦ 【${event.skill_name}】${nameOf(event.player_id)}${note}`;
    }
    if (etype === 'steal') {
        const target = nameOf(event.from_id);
        if (event.to_id) {
            return `**${nameOf(event.to_id)}** 获得 ${target} 的${event.zone_text}${event.reason ? `（${event.reason}）` : ''}`;
        }
        return `**${target}** 被弃置 ${event.zone_text}${event.reason ? `（${event.reason}）` : ''}`;
    }
    if (etype === 'discard') {
        return `**${nameOf(event.player_id)}** 弃置 ${event.count} 张手牌`;
    }
    if (etype === 'judgment') {
        return `【${event.reason}】判定牌为 ${event.card_short}`;
    }
    if (etype === 'pending') return null;
    if (etype === 'winner') return `🏆 游戏结束：**${event.side}**获胜！`;
    if (etype === 'note') return event.text;
    return null;
}

function formatEvents(events, nameOf, limit = 14) {
    const lines = [];
    for (const e of events) {
        const line = formatEvent(e, nameOf);
        if (line) lines.push(line);
    }
    return lines.slice(-limit);
}

function hpBar(hp, maxHp) {
    const cur = Math.max(0, hp || 0);
    const max = Math.max(0, maxHp || 0);
    return '❤'.repeat(cur) + '♡'.repeat(Math.max(0, max - cur));
}

function playerLines(game) {
    const view = game.publicView();
    const currentUid = view.turnUserId;
    const lines = [];

    for (const p of view.players) {
        const marker = (p.userId === currentUid && view.started && !view.finished) ? ' ➤' : '';
        const life = (p.hp !== null && p.hp !== undefined) ? `${hpBar(p.hp, p.maxHp)} ${p.hp}/${p.maxHp}` : '－';
        const role = (!p.alive || view.finished || p.role === '主公') ? `｜身份 ${p.role}` : '';
        const equips = Object.values(p.equipment).join('、') || '无';
        const delayed = p.delayed.map(d => `【${d}】`).join('、') || '无';

        const stateTags = [];
        if (!p.alive) stateTags.push('阵亡');
        if (p.autoPlay) stateTags.push('托管中');
        const stateStr = stateTags.length ? `（${stateTags.join('，')}）` : '';

        lines.push(`\`${p.name}\`｜${p.general || '随机'}｜${life}${role}｜手牌 ${p.handCount}｜装备 ${equips}｜判定 ${delayed}${stateStr}${marker}`);
    }
    return lines;
}

function pendingLine(game) {
    const top = game.pendingTop;
    if (!top) return null;
    const nameOf = (pid) => {
        const found = game.players.find(p => p.userId === String(pid));
        return found ? found.name : '？';
    };

    if (top.kind === 'nullify') {
        return `⚡ 【${top.data.trick_name}】生效前！**12 秒抢断窗口**：手上有【无懈可击】可点「⚡ 抢出无懈」抵消，无人抢出则照常生效。`;
    }
    if (top.kind === 'attack') {
        return `⏳ 等待 **${nameOf(top.deciderId)}** 响应 ${top.data.card_short || '【杀】'}（还需闪避 ${top.data.dodges_left} 次；限时内不响应将自动托管）`;
    }
    if (top.kind === 'aoe') {
        return `⏳ 【${top.data.trick_name}】等待 **${nameOf(top.deciderId)}** 出【${top.data.needed}】（限时内不响应将自动托管）`;
    }
    if (top.kind === 'duel') {
        return `⏳ 【决斗】等待 **${nameOf(top.deciderId)}** 出【杀】（限时内不响应将自动托管）`;
    }
    if (top.kind === 'dying') {
        return `⚠️ **${nameOf(top.data.dying_id)}** 濒死！等待 **${nameOf(top.deciderId)}** 出桃救援（限时内不响应将自动跳过）`;
    }
    if (top.kind === 'zone') {
        const target = nameOf(top.data.target_id);
        const verb = (top.data.mode === 'steal') ? '获取' : '弃置';
        return `⏳ 等待 **${nameOf(top.deciderId)}** 选择${verb} ${target} 的哪个区域`;
    }
    if (top.kind === 'discard') {
        return `⏳ 等待 **${nameOf(top.deciderId)}** 弃牌（需弃 ${top.data.count} 张）`;
    }
    if (top.kind === 'blade_pursue') {
        return `🗡️ 【青龙偃月刀】发动！等待 **${nameOf(top.deciderId)}** 决定是否追加出杀`;
    }
    if (top.kind === 'bow_mount') {
        return `🏹 【麒麟弓】命中！等待 **${nameOf(top.deciderId)}** 拆除目标的坐骑`;
    }
    return null;
}

function renderMain(game, logLines = null) {
    const view = game.publicView();
    let embed;

    if (!view.started) {
        embed = new EmbedBuilder()
            .setTitle('🏯 三国杀房间')
            .setDescription('等待开局（3～8 人）')
            .setColor(0xE8B14E);
    } else if (view.finished) {
        embed = new EmbedBuilder()
            .setTitle('🏁 对局结束')
            .setDescription(`**${view.winner}**获胜！`)
            .setColor(0x67B57C);
    } else {
        const state = pendingLine(game);
        const head = `轮到 **${view.turnName}** 的回合${state ? `\n${state}` : ''}\n⏳ 长时间不操作将自动托管并结束回合`;
        embed = new EmbedBuilder()
            .setTitle('⚔️ 三国杀')
            .setDescription(head)
            .setColor(0xD05A5A);
    }

    const lines = playerLines(game);
    if (lines.length > 0) {
        embed.addFields({ name: '场上', value: lines.join('\n'), inline: false });
    }

    if (logLines && logLines.length > 0) {
        // 超 1000 字按行边界裁（字符硬切会把 emoji/粗体标记切半，渲染出破行）。
        let text = logLines.join('\n');
        if (text.length > 1000) {
            const cut = text.lastIndexOf('\n', 1000);
            text = cut > 200 ? text.slice(0, cut) + '\n…' : `${text.slice(0, 1000)}…`;
        }
        embed.addFields({ name: '战报', value: text || '—', inline: false });
    }

    embed.setFooter({ text: `牌库+弃牌 ${view.deckCount} 张｜点「🃏 我的信息」查看私密手牌` });
    return embed;
}

function renderRecruit(game, ownerMention) {
    const rows = [];
    for (const p of game.players) {
        let row = `\`${p.name}\`` + (p.userId === game.ownerId ? '（房主）' : '');
        if (p.general) row += `｜【${p.general}】`;
        rows.push(row);
    }
    return new EmbedBuilder()
        .setTitle('🏯 三国杀招募')
        .setDescription(`${ownerMention} 的房间（${game.players.length}/8）\n\n${rows.join('\n')}`)
        .setColor(0xE8B14E)
        .setFooter({ text: '点击下方「上桌」即可加入；满 3 人房主可直接开局｜可点击「挑选武将」自定武将' });
}

function renderPrivate(game, userId) {
    try {
        const view = game.privateView(userId);
        if (!view.general) return null;
        const skill = view.skill;
        const handLines = view.hand.map((card, i) => `${i + 1}. ${card.detail}`);
        const handText = handLines.slice(0, 25).join('\n') || '（空）';

        const equips = Object.entries(view.equipment).map(([slot, card]) => `「${slot}」${card.short}`).join('\n') || '无';
        const delayed = view.delayed.map(d => `【${d}】`).join('、') || '无';
        const roleText = view.role || '未分配';
        const statusSuffix = view.autoPlay ? '【托管中】' : '';

        const skillText = skill ? `【${skill.skillName}】${skill.description || ''}` : '？';
        const desc = `身份：**${roleText}**｜武将：**${view.general}** ${statusSuffix}\n` +
                     `技能：${skillText}\n` +
                     `体力：${hpBar(view.hp, view.maxHp)} ${view.hp}/${view.maxHp}｜攻击范围：${view.attackRange}`;

        return new EmbedBuilder()
            .setTitle(`🃏 ${view.name} 的私密信息`)
            .setDescription(desc)
            .setColor(0x5A8FD0)
            .addFields(
                { name: `手牌（${view.hand.length}）`, value: handText.slice(0, 1024), inline: false },
                { name: '装备', value: equips, inline: true },
                { name: '判定区', value: delayed, inline: true },
            );
    } catch (_) {
        return null;
    }
}

function buildMainComponents(game) {
    const guildId = game.guildId;
    const token = game.actionToken;

    const row0 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sgs:m:${guildId}:${token}:hand`).setLabel('🃏 我的信息').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`sgs:m:${guildId}:${token}:play`).setLabel('🎴 出牌').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`sgs:m:${guildId}:${token}:respond`).setLabel('🛡 响应').setStyle(ButtonStyle.Success),
    );

    const top = game.pendingTop;
    if (top && top.kind === 'nullify') {
        row0.addComponents(
            new ButtonBuilder().setCustomId(`sgs:m:${guildId}:${token}:nullify`).setLabel('⚡ 抢出无懈').setStyle(ButtonStyle.Success),
        );
    }

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sgs:m:${guildId}:${token}:skill`).setLabel('✦ 技能').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`sgs:m:${guildId}:${token}:end`).setLabel('⏭ 结束回合').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`sgs:m:${guildId}:${token}:rules`).setLabel('📜 规则手册').setStyle(ButtonStyle.Secondary),
    );

    if (game.players.some(p => p.alive && p.autoPlay)) {
        row1.addComponents(
            new ButtonBuilder().setCustomId(`sgs:m:${guildId}:${token}:cancel_auto`).setLabel('🙋 取消托管').setStyle(ButtonStyle.Secondary),
        );
    }

    return [row0, row1];
}

function buildRecruitComponents(game) {
    const guildId = game.guildId;

    const row0 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sgs:r:${guildId}:0:join`).setLabel('🪑 上桌').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`sgs:r:${guildId}:0:leave`).setLabel('🚪 离桌').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`sgs:r:${guildId}:0:choose`).setLabel('🎭 挑选武将').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`sgs:r:${guildId}:0:rules`).setLabel('📜 规则手册').setStyle(ButtonStyle.Secondary),
    );

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sgs:r:${guildId}:0:start`).setLabel('🀄 开始游戏').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`sgs:r:${guildId}:0:dissolve`).setLabel('🧹 解散房间').setStyle(ButtonStyle.Danger),
    );

    return [row0, row1];
}

module.exports = {
    formatEvents,
    hpBar,
    playerLines,
    pendingLine,
    renderMain,
    renderRecruit,
    renderPrivate,
    buildMainComponents,
    buildRecruitComponents,
};
