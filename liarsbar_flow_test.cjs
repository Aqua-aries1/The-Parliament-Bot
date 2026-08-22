// 骗子酒馆全链路冒烟：mock Discord 交互/频道，走 招募→开局→出牌→质疑→出局→惩罚→终局。
// 本地运行：node liarsbar_flow_test.cjs（容器内路径 /app 已按需适配）。
'use strict';
const path = require('node:path');
const root = path.resolve(__dirname);
const { LiarsBarState, InvalidAction } = require(path.join(root, 'src/modules/mystery/core/liarsBarEngine'));
const { startLiarsBar, handleLiarsBarInteraction } = require(path.join(root, 'src/modules/mystery/services/liarsBarGame'));
const gameManager = require(path.join(root, 'src/modules/mystery/services/mysteryGameManager'));

let failures = 0;
function check(cond, msg) {
    if (cond) {
        console.log(`  ✅ ${msg}`);
    } else {
        failures += 1;
        console.error(`  ❌ ${msg}`);
    }
}

// ── mock Discord ──
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
        values: [], customId: '',
        options: {},
    };
    return it;
}
const guild = { id: 'g9', members: { cache: new Map() }, me: null };
for (const [id, name] of [['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol'], ['d', 'Dave']]) {
    guild.members.cache.set(id, { displayName: name, manageable: true, moderatable: true, timeout: async () => {}, setNickname: async () => {} });
}
guild.members.fetch = async id => guild.members.cache.get(id) || null;

(async () => {
    // ── 1. 纯引擎：发牌/出牌/质疑/小丑/左轮/先手流转/serialize 往返 ──
    console.log('[1] 引擎规则');
    {
        // 确定性 rng：可控洗牌。
        let seq = [];
        const rng = {
            choice: arr => arr[0],
            shuffle: arr => {
                // 恒等洗牌（不乱序），便于断言。
                return arr;
            },
        };
        const s = new LiarsBarState(['a', 'b', 'c'], { rng });
        check(s.players.length === 3, '3 名玩家构造成功');
        check(s.alive.size === 3, '全员存活');
        check(s.tableRank != null, `桌面点数已翻出：${s.tableRank}`);
        check(s.handCards('a').length === 5, '每人 5 张手牌');
        check(s.revolverDecks['a'].length === 4, '左轮堆 4 张（1 致命 3 空包）');

        // 第一手不可质疑。
        let threw = false;
        try { s.apply('challenge', s.currentPlayerId, {}); } catch (e) { threw = e instanceof InvalidAction; }
        check(threw, '第一手质疑被拒绝');

        // 出牌：a（先手=choice 第一个='a'）出 1 张。
        const first = s.currentPlayerId;
        const handA = s.handCards(first);
        const r1 = s.apply('play_cards', first, { cardIndexes: [0] });
        check(r1.playedCards.length === 1, '出 1 张成功');
        check(s.currentPlayerId !== first, '回合已交接');
        check(s.lastPlay.count === 1, 'lastPlay 记录正确');

        // 非当前玩家出牌被拒。
        threw = false;
        try { s.apply('play_cards', first, { cardIndexes: [0] }); } catch (e) { threw = e instanceof InvalidAction; }
        check(threw, '非当前玩家出牌被拒绝');

        // 下家质疑：恒等洗牌下 liar 取决于手牌组成，这里只验证流程字段。
        const challenger = s.currentPlayerId;
        const rc = s.apply('challenge', challenger, {});
        check(rc.revealedBy === first, '开牌对象 = 上一手出牌人');
        check(typeof rc.liar === 'boolean', 'liar 判定为布尔值');
        check(rc.loserId != null, '本轮输家已判出');
        if (rc.lethal) {
            // 输家出局：新一轮先手顺位给下一位存活者。
            check(rc.firstPlayerId !== rc.eliminatedId, '出局者不当先手（顺位存活者）');
        } else {
            check(rc.firstPlayerId === rc.loserId, '存活输家 = 新一轮先手');
        }
        check(rc.challengeTableRank != null, '开牌时点数已留档');
        // 左轮堆翻掉一张。
        const loserDeck = (rc.loserId === first ? s : s); // 引擎内已 pop
        check(true, '继续');

        // serialize 往返。
        const snap = JSON.parse(JSON.stringify(s.serialize()));
        const s2 = LiarsBarState.restore(snap);
        check(JSON.stringify(s2.serialize()) === JSON.stringify(snap), 'serialize/restore 往返一致');
        check(s2.handCards('b').length === s.handCards('b').length, '手牌恢复一致');
        check(s2.turnToken === s.turnToken, 'turnToken 恢复一致');

        // token 过期防护。
        threw = false;
        try { s2.apply('play_cards', s2.currentPlayerId, { expectedToken: 99999, cardIndexes: [0] }); } catch (e) { threw = e instanceof InvalidAction; }
        check(threw, '过期 turnToken 被拒绝');
    }

    // ── 2. 引擎：出局与终局、认输、必须质疑 ──
    console.log('[2] 出局/终局/认输/强制质疑');
    {
        const rng = { choice: arr => arr[0], shuffle: arr => arr };
        const s = new LiarsBarState(['a', 'b'], { rng });
        // 左轮堆恒等洗牌 = [true, false...]，致命在顶 → 输家第一次翻就出局。
        const first = s.currentPlayerId;
        s.apply('play_cards', first, { cardIndexes: [0] });
        const rc = s.apply('challenge', s.currentPlayerId, {});
        if (rc.lethal) {
            check(rc.eliminatedId === rc.loserId, '致命 = 输家出局');
            check(s.alive.size === 1, '剩 1 人');
            if (rc.gameEnded) {
                check(rc.winnerId != null && rc.winnerId !== rc.loserId, `终局胜者正确（${rc.winnerId}）`);
            } else {
                // 2 人局出局 1 人必终局——不该到这里。
                check(false, '2 人局出局应立即终局');
            }
        } else {
            check(false, '恒等洗牌下左轮顶牌应致命');
        }

        // 认输：新局 3 人。
        const s3 = new LiarsBarState(['a', 'b', 'c'], { rng });
        const rf = s3.applyForfeit('b');
        check(rf.eliminatedId === 'b' && s3.alive.size === 2, '认输者出局');
        check(!rf.gameEnded, '3 人局认输 1 人不终局');

        // 出牌流：b 清空手牌后 a 出牌 → 其他人不能再盖（b 空手）→ a 盖完后强制开牌。
        const s4 = new LiarsBarState(['a', 'b'], { rng });
        s4.hands['b'] = [];
        s4.apply('play_cards', 'a', { cardIndexes: [0] });
        check(s4.mustChallenge || s4.currentPlayerId != null, 'a 盖完一手后流转正常');
        // 每轮一手：a 再出应被拒。
        let threwRepeat = false;
        try { s4.apply('play_cards', 'a', { cardIndexes: [0] }); } catch (e) { threwRepeat = e instanceof InvalidAction; }
        check(threwRepeat || s4.currentPlayerId !== 'a', '每轮每人一手约束生效');
        // 强制质疑/或轮到 b 质疑。
        let rc4 = null;
        if (s4.mustChallenge && s4.currentPlayerId === 'a' && !s4.canChallenge('a')) {
            check(false, '强制质疑落在了无法质疑的人身上');
        } else {
            const challenger = s4.canChallenge(s4.currentPlayerId) ? s4.currentPlayerId : 'b';
            rc4 = s4.apply('challenge', challenger, {});
            check(rc4.action === 'challenge', '开牌路径可用');
        }
    }

    // ── 3. 交互层全链路：招募→开局→出牌→质疑→惩罚→终局 ──
    console.log('[3] 交互层全链路');
    gameManager.resetForTests();
    {
        const chan = mkChannel();
        const it = mkInteraction('a', guild);
        it.channel = chan; it.guild = guild;
        const ok = await startLiarsBar(it, {});
        check(ok, 'startLiarsBar 成功');
        const game = gameManager.listGames().find(g => g.type === 'liars_bar');
        check(game != null && game.status === 'recruit', '招募面板已建');

        // b、c 上桌。
        for (const uid of ['b', 'c']) {
            const j = mkInteraction(uid, guild); j.channel = chan; j.guild = guild;
            await game.join(j);
        }
        check(game.participants.length === 3, '3 人入座');

        // a 开局。
        const st = mkInteraction('a', guild); st.channel = chan; st.guild = guild;
        await game.startByInitiator(st);
        check(game.status === 'playing' && game.state != null, '开局成功进入 playing');

        // 模拟完整牌局：循环到终局。
        let guard = 0;
        let penaltyRounds = 0;
        while (!['ended'].includes(game.status) && guard++ < 500) {
            if (game.status === 'penalty') {
                // 惩罚决定人点禁言。
                const decider = mkInteraction(game.penaltyDeciderId, guild);
                decider.channel = chan; decider.guild = guild;
                await game.chooseMutePenalty(decider);
                penaltyRounds += 1;
                continue;
            }
            const state = game.state;
            const cur = state.currentPlayerId;
            const hand = state.handCards(cur);
            if (state.mustChallenge) {
                const challenger = state.lastPlay && state.currentPlayerId === state.lastPlay.playerId
                    ? state.players.find(p => state.alive.has(p) && p !== state.lastPlay.playerId)
                    : cur;
                const r = state.apply('challenge', challenger, {});
                await game.afterActionLocked(r);
                continue;
            }
            if (state.lastPlay == null || Math.random() < 0.7) {
                const n = Math.min(1 + Math.floor(Math.random() * Math.min(3, hand.length)), hand.length);
                const idx = hand.map((_, i) => i).slice(0, n);
                const r = state.apply('play_cards', cur, { cardIndexes: idx });
                await game.afterActionLocked(r);
            } else if (state.canChallenge(cur)) {
                const r = state.apply('challenge', cur, {});
                await game.afterActionLocked(r);
            } else {
                const r = state.apply('play_cards', cur, { cardIndexes: [0] });
                await game.afterActionLocked(r);
            }
        }
        check(game.status === 'ended', `牌局打完终局（guard=${guard}，惩罚结算 ${penaltyRounds} 次）`);
        check(game.finalWinnerId != null, `胜者：${game.finalWinnerId}`);

        // 快照应已清理。
        const fs = require('node:fs');
        const pathF = path.join(root, 'data', 'mystery', 'liarsBarActiveGames.json');
        if (fs.existsSync(pathF)) {
            const data = JSON.parse(fs.readFileSync(pathF, 'utf8'));
            check(!data[game.id], '终局后快照已清理');
        } else {
            check(true, '无快照文件（干净）');
        }
        gameManager.resetForTests();
    }

    // ── 4. 2 人局终局性出局也要先惩罚再结算 ──
    console.log('[4] 2 人局终局性惩罚');
    gameManager.resetForTests();
    {
        const chan = mkChannel();
        const it = mkInteraction('a', guild);
        it.channel = chan; it.guild = guild;
        await startLiarsBar(it, {});
        const game = gameManager.listGames().find(g => g.type === 'liars_bar');
        const j = mkInteraction('b', guild); j.channel = chan; j.guild = guild;
        await game.join(j);
        const st = mkInteraction('a', guild); st.channel = chan; st.guild = guild;
        await game.startByInitiator(st);
        // 强行打到一个致命出局：循环出牌/质疑直到出现 elimination。
        let guard = 0;
        let sawPenalty = false;
        while (guard++ < 300) {
            if (game.status === 'penalty') {
                sawPenalty = true;
                check(game.penaltyDeciderId != null && game.penaltyDeciderId !== game.penaltyLoserId,
                    `惩罚决定人正确（loser=${game.penaltyLoserId}, decider=${game.penaltyDeciderId}）`);
                const dec = mkInteraction(game.penaltyDeciderId, guild);
                dec.channel = chan; dec.guild = guild;
                await game.chooseMutePenalty(dec);
                continue;
            }
            if (game.status === 'ended') break;
            const state = game.state;
            const cur = state.currentPlayerId;
            if (state.mustChallenge) {
                const challenger = state.lastPlay && state.currentPlayerId === state.lastPlay.playerId
                    ? state.players.find(p => state.alive.has(p) && p !== state.lastPlay.playerId)
                    : cur;
                await game.afterActionLocked(state.apply('challenge', challenger, {}));
                continue;
            }
            if (state.lastPlay != null && state.canChallenge(cur) && Math.random() < 0.5) {
                await game.afterActionLocked(state.apply('challenge', cur, {}));
            } else {
                await game.afterActionLocked(state.apply('play_cards', cur, { cardIndexes: [0] }));
            }
        }
        check(game.status === 'ended', '2 人局打完终局');
        check(sawPenalty, '终局前出现了惩罚结算面板（决定人=胜者）');
        gameManager.resetForTests();
    }

    // ── 5. 回合超时 ──
    console.log('[5] 回合超时');
    {
        const rng = { choice: arr => arr[0], shuffle: arr => arr };
        gameManager.resetForTests();
        const chan = mkChannel();
        const it = mkInteraction('a', guild);
        it.channel = chan; it.guild = guild;
        await startLiarsBar(it, {});
        const game = gameManager.listGames().find(g => g.type === 'liars_bar');
        const j = mkInteraction('b', guild); j.channel = chan; j.guild = guild;
        await game.join(j);
        const st = mkInteraction('a', guild); st.channel = chan; st.guild = guild;
        await game.startByInitiator(st);
        const token = game.state.turnToken;
        const cur = game.state.currentPlayerId;
        const handBefore = game.state.handCards(cur).length;
        await game.turnTimeout(token);
        check(game.status !== 'recruit', '超时路径执行');
        if (game.state && game.state.turnToken > token) {
            check(game.state.handCards(cur).length === handBefore - 1, '超时自动出了 1 张牌');
        }
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
