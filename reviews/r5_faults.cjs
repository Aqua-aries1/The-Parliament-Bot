// R5 健壮性故障注入：惩罚阶段失格补判 / 非参与者忽略 / 渲染失败兜底 / cleanup 幂等。
'use strict';
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const gameManager = require(path.join(root, 'src/modules/mystery/services/mysteryGameManager'));
const {
    startLiarsDice,
    handleLiarsDiceMemberInvalidated,
} = require(path.join(root, 'src/modules/mystery/services/liarsDiceGame'));
const {
    startLiarsBar,
    handleLiarsBarMemberInvalidated,
} = require(path.join(root, 'src/modules/mystery/services/liarsBarGame'));

let failures = 0;
function check(cond, label) {
    if (cond) { console.log(`  ✅ ${label}`); } else { failures += 1; console.log(`  ❌ ${label}`); }
}

function mkMsg() {
    return { id: 'm' + Math.random().toString(36).slice(2, 8), edit: async () => {}, delete: async () => {}, embeds: [] };
}
function mkChannel() {
    return { id: 'c1', send: async () => mkMsg(), messages: { delete: async () => {} } };
}
function mkInteraction(user, guild) {
    const it = {
        user: { id: user, bot: false }, guild, channelId: 'c1',
        deferred: false, replied: false,
        deferReply: async () => { it.deferred = true; },
        deferUpdate: async () => { it.deferred = true; },
        editReply: async () => ({}), reply: async () => { it.replied = true; }, followUp: async () => ({}),
        isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
        values: [], customId: '', options: {},
    };
    return it;
}

function mkGuild(presentIds) {
    const guild = { id: 'g9', members: { cache: new Map() }, me: null };
    for (const [id, name] of presentIds) {
        guild.members.cache.set(id, { displayName: name, manageable: true, moderatable: true, timeout: async () => {}, setNickname: async () => {} });
    }
    guild.members.fetch = async id => guild.members.cache.get(id) || null;
    return guild;
}

async function driveToPlaying(game, guild, chan, uids) {
    for (const uid of uids.slice(1)) {
        const j = mkInteraction(uid, guild); j.channel = chan; j.guild = guild;
        await game.join(j);
    }
    const st = mkInteraction(uids[0], guild); st.channel = chan; st.guild = guild;
    await game.startByInitiator(st);
}

async function settlePenalty(game, guild) {
    const dec = mkInteraction(game.penaltyDeciderId, guild);
    dec.channel = game.channel; dec.guild = guild;
    await game.chooseMutePenalty(dec);
}

(async () => {
    console.log('[1] 骰子：惩罚阶段失格 → 延迟补判');
    gameManager.resetForTests();
    {
        // d 不在成员缓存里（模拟已退服），但作为玩家正常入座。
        const guild = mkGuild([['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol']]);
        const chan = mkChannel();
        const it = mkInteraction('a', guild); it.channel = chan; it.guild = guild;
        await startLiarsDice(it, {});
        const game = gameManager.listGames().find(g => g.type === 'liars_dice');
        await driveToPlaying(game, guild, chan, ['a', 'b', 'c', 'd']);
        check(game.status === 'playing', '开局成功');
        // 直接构造一次出局惩罚（走引擎认输，保持与真实流一致的惩罚面板）。
        game.state.applyForfeit('b');
        game.penaltyQueue = [];
        await game.beginEliminationPenaltyLocked('b', 'surrender');
        check(game.status === 'penalty', '进入惩罚结算');
        // b 结算期间 d 退服失格 → 应被记录而非忽略。
        await gameManager.handleGuildMemberRemove({ id: "d", guildId: "g9" });
        check(game.pendingInvalidations?.has('d') === true, '惩罚阶段失格被接住（不忽略）');
        check(game.pendingInvalidations?.has('d') === true, '失格已登记待补判');
        check(game.state.alive.has('d'), '结算期间状态未动（d 仍存活）');
        // 结算 b 的惩罚 → 恢复时应补判 d → d 进入惩罚结算。
        await settlePenalty(game, guild);
        check(game.status === 'penalty' && game.penaltyLoserId === 'd', `恢复后补判 d（loser=${game.penaltyLoserId}）`);
        check(!game.state.alive.has('d'), 'd 已出局');
        // 再结算 d → 正常回到 playing。
        await settlePenalty(game, guild);
        check(game.status === 'playing', '全部罚完回到对局');
    }

    console.log('[2] 酒馆：惩罚阶段失格 → 延迟补判');
    gameManager.resetForTests();
    {
        const guild = mkGuild([['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol']]);
        const chan = mkChannel();
        const it = mkInteraction('a', guild); it.channel = chan; it.guild = guild;
        await startLiarsBar(it, {});
        const game = gameManager.listGames().find(g => g.type === 'liars_bar');
        await driveToPlaying(game, guild, chan, ['a', 'b', 'c', 'd']);
        check(game.status === 'playing', '开局成功');
        game.state.applyForfeit('b');
        await game.beginEliminationPenaltyLocked('b', 'surrender');
        await gameManager.handleGuildMemberRemove({ id: "d", guildId: "g9" });
        check(game.pendingInvalidations?.has('d') === true, '惩罚阶段失格已登记');
        await settlePenalty(game, guild);
        check(game.status === 'penalty' && game.penaltyLoserId === 'd', '恢复后补判 d');
        await settlePenalty(game, guild);
        check(game.status === 'playing' && !game.state.alive.has('d'), '酒馆补判流程闭环');
    }

    console.log('[3] 非参与者失格 → 忽略');
    {
        const game = gameManager.listGames().find(g => g.type === 'liars_bar');
        const before = JSON.stringify(game.state.alive);
        await gameManager.handleGuildMemberRemove({ id: "zzz", guildId: "g9" });
        check(game.pendingInvalidations?.size == null || game.pendingInvalidations.size === 0, '非参与者未登记');
        check(JSON.stringify(game.state.alive) === before, '状态无变化');
    }

    console.log('[4] 渲染失败兜底（channel.send 炸一次）');
    gameManager.resetForTests();
    {
        const guild = mkGuild([['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol']]);
        const chan = mkChannel();
        let failNext = false;
        let threw = false;
        chan.send = async () => {
            if (failNext) { failNext = false; threw = true; throw new Error('simulated discord outage'); }
            return mkMsg();
        };
        const it = mkInteraction('a', guild); it.channel = chan; it.guild = guild;
        await startLiarsDice(it, {});
        const game = gameManager.listGames().find(g => g.type === 'liars_dice');
        await driveToPlaying(game, guild, chan, ['a', 'b', 'c', 'd']);
        // 下一帧渲染遇故障：不应向上抛，游戏状态照常推进。
        failNext = true;
        const st = game.state;
        const cur = st.currentPlayerId;
        const tokenBefore = st.turnToken; // 快照：st 是活引用，动作后 turnToken 会被同步更新
        await game.act(mkInteraction(cur, guild), 'bid', st.turnToken, { bid: { count: 1, face: 6 } });
        check(threw, '故障确实注入');
        check(game.status === 'playing' && game.state != null, '渲染失败后对局仍活着');
        check(game.state.turnToken === tokenBefore + 1, '动作本身已生效（token 前进）');
    }

    console.log('[5] cleanupGame 幂等');
    {
        const game = gameManager.listGames()[0];
        await gameManager.cleanupGame(game);
        await gameManager.cleanupGame(game); // 第二次应为 no-op 不抛
        check(gameManager.listGames().length === 0, '锁与登记清空');
    }

    if (failures > 0) {
        console.error(`\n${failures} 项断言失败。`);
        process.exit(1);
    }
    console.log('\nALL FAULT-INJECTION CHECKS PASS');
    process.exit(0);
})().catch(error => {
    console.error('测试异常：', error);
    process.exit(1);
});
