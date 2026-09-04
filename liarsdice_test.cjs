// 骗子骰子引擎 + 交互层全链路测试。运行：node liarsdice_test.cjs
'use strict';
const path = require('node:path');
const root = path.resolve(__dirname);
const { LiarsDiceState, InvalidAction, MIN_FACE, START_DICE_BY_PLAYERS: START_DICE } = require(path.join(root, 'src/modules/mystery/core/liarsDiceEngine'));
const { startLiarsDice } = require(path.join(root, 'src/modules/mystery/services/liarsDiceGame'));
const gameManager = require(path.join(root, 'src/modules/mystery/services/mysteryGameManager'));

let failures = 0;
function check(cond, msg) {
    if (cond) console.log(`  ✅ ${msg}`);
    else { failures += 1; console.error(`  ❌ ${msg}`); }
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
const guild = { id: 'g9', members: { cache: new Map() }, me: null };
for (const [id, name] of [['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol']]) {
    guild.members.cache.set(id, { displayName: name, manageable: true, moderatable: true, timeout: async () => {}, setNickname: async () => {} });
}
guild.members.fetch = async id => guild.members.cache.get(id) || null;

(async () => {
    console.log('[1] 引擎规则');
    {
        const rng = { random: () => 0.99 }; // 0.99 → 恒掷出 6
        const s = new LiarsDiceState(['a', 'b', 'c', 'd', 'e'], { rng, firstPlayerId: 'a' });
        check(s.players.length === 5, '5 名玩家构造成功');
        check(s.diceCount('a') === 4, '5 人局起手 4 骰');
        check(s.totalDice() === 20, '5 人局全场 20 骰');
        // 首叫：1 不可叫。
        let threw = false;
        try { s.apply('bid', 'a', { bid: { count: 1, face: 1 } }); } catch (e) { threw = e instanceof InvalidAction; }
        check(threw, '叫 1（万能面）被拒绝');
        s.apply('bid', 'a', { bid: { count: 2, face: 3 } });
        check(s.currentBid.count === 2 && s.currentBid.face === 3, '首叫 2 个 3 成功');
        check(s.currentPlayerId !== 'a', '回合交接');
        // 非法加注：数量更少。
        threw = false;
        const cur = s.currentPlayerId;
        try { s.apply('bid', cur, { bid: { count: 1, face: 5 } }); } catch (e) { threw = e instanceof InvalidAction; }
        check(threw, '数量更少的加注被拒绝');
        // 同数量更小点数。
        threw = false;
        try { s.apply('bid', cur, { bid: { count: 2, face: 2 } }); } catch (e) { threw = e instanceof InvalidAction; }
        check(threw, '同数量更小点数被拒绝');
        // 合法加注：同数量更大点数。
        s.apply('bid', cur, { bid: { count: 2, face: 5 } });
        check(s.currentBid.face === 5, '同数量更大点数合法');
        // 开牌：数量统计含万能 1（rng 恒 6 → 无 1 无 5 → 0 个 → 吹牛成立）。
        const opener = s.currentPlayerId;
        const r = s.apply('open', opener, {});
        check(r.calledBid.count === 2 && r.calledBid.face === 5, 'calledBid 留档正确');
        check(r.totalCalled === 0, `恒 6 骰面下被叫点数计数为 0（实际 ${r.totalCalled}）`);
        check(r.bidHolds === false, '叫点不成立（吹牛）');
        check(r.loserId != null && r.loserId === r.calledBid.playerId, '输家 = 吹牛的叫点者');
        check(s.diceCount(r.loserId) === 4 - 1, '输家失 1 骰');
        check(r.newRound && r.firstPlayerId === r.loserId, '新一轮先手 = 输家');
        // serialize 往返。
        const snap = JSON.parse(JSON.stringify(s.serialize()));
        const s2 = LiarsDiceState.restore(snap);
        check(JSON.stringify(s2.serialize()) === JSON.stringify(snap), 'serialize/restore 往返一致');
        // token 过期。
        threw = false;
        try { s2.apply('bid', s2.currentPlayerId, { expectedToken: 999, bid: { count: 1, face: 2 } }); } catch (e) { threw = e instanceof InvalidAction; }
        check(threw, '过期 token 被拒绝');
    }

    console.log('[2] 出局与终局');
    {
        const rng = { random: () => 0.99 };
        const s = new LiarsDiceState(['a', 'b', 'c', 'd'], { rng, firstPlayerId: 'a' });
        // 直接把 a 的骰子削到 1 颗，输一轮即出局。
        s.dice['a'] = [6];
        s.apply('bid', 'a', { bid: { count: 3, face: 6 } }); // 全场 6 骰，a 恒 6：真实 6 的数量 = 6 ≥ 3 成立
        const r = s.apply('open', 'b', {});
        check(r.bidHolds === true, '数量够 → 叫点成立');
        check(r.loserId === 'b', '开牌者失骰');
        // 再来一轮把 b 打空。
        let guard = 0;
        while (s.phase !== 'ended' && guard++ < 50) {
            const cur = s.currentPlayerId;
            if (s.currentBid == null) {
                s.apply('bid', cur, { bid: { count: 1, face: 6 } });
            } else {
                s.apply('open', cur, {});
            }
        }
        check(s.phase === 'ended' && s.winnerId != null, `4 人局终局，胜者 ${s.winnerId}`);
        // 认输。
        const s3 = new LiarsDiceState(['a', 'b', 'c', 'd'], { rng, firstPlayerId: 'a' });
        const rf = s3.applyForfeit('b');
        check(rf.eliminatedId === 'b' && s3.alive.size === 3, '认输者出局');
    }

    console.log('[3] 交互层全链路');
    gameManager.resetForTests();
    {
        const chan = mkChannel();
        const it = mkInteraction('a', guild);
        it.channel = chan; it.guild = guild;
        const ok = await startLiarsDice(it, {});
        check(ok, 'startLiarsDice 成功');
        const game = gameManager.listGames().find(g => g.type === 'liars_dice');
        check(game != null && game.status === 'recruit', '招募面板已建');
        for (const uid of ['b', 'c', 'd']) {
            const j = mkInteraction(uid, guild); j.channel = chan; j.guild = guild;
            await game.join(j);
        }
        const st = mkInteraction('a', guild); st.channel = chan; st.guild = guild;
        await game.startByInitiator(st);
        check(game.status === 'playing' && game.state != null, '开局成功');
        // 全自动打完：首叫最小点，已有叫点 50% 开牌。
        let guard = 0;
        let penalties = 0;
        while (game.status !== 'ended' && guard++ < 600) {
            if (game.status === 'penalty') {
                const dec = mkInteraction(game.penaltyDeciderId, guild);
                dec.channel = chan; dec.guild = guild;
                await game.chooseMutePenalty(dec);
                penalties += 1;
                continue;
            }
            const state = game.state;
            const cur = state.currentPlayerId;
            if (state.currentBid == null) {
                await game.act(mkAct('bid', cur), 'bid', state.turnToken, { bid: { count: 1, face: MIN_FACE } });
            } else if (Math.random() < 0.4) {
                await game.act(mkAct('open', cur), 'open', state.turnToken);
            } else {
                // 找一个合法加注（比上一手大一点���。
                const bid = state.currentBid;
                let nb;
                if (bid.face < 6) nb = { count: bid.count, face: bid.face + 1 };
                else nb = { count: bid.count + 1, face: MIN_FACE };
                if (nb.count > state.totalDice()) nb = null;
                if (nb == null) {
                    await game.act(mkAct('open', cur), 'open', state.turnToken);
                } else {
                    await game.act(mkAct('bid', cur), 'bid', state.turnToken, { bid: nb });
                }
            }
        }
        function mkAct(kind, cur) {
            const ii = mkInteraction(cur, guild);
            ii.channel = chan; ii.guild = guild;
            ii.isButton = () => true;
            return ii;
        }
        check(game.status === 'ended', `牌局打完终局（guard=${guard}，惩罚 ${penalties} 次）`);
        check(game.finalWinnerId != null, `胜者：${game.finalWinnerId}`);
        gameManager.resetForTests();
    }

    if (failures > 0) {
        console.error(`\n${failures} 项断言失败。`);
        process.exit(1);
    }
    console.log('\n全部通过。');
})().catch(error => {
    console.error('测试异常：', error);
    process.exit(1);
});
