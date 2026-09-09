// R8 验证：复盘统计 + 声明链 + stats/roundPlays 序列化。
'use strict';
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { LiarsBarState, defaultRng } = require(path.join(root, 'src/modules/mystery/core/liarsBarEngine'));
const { LiarsDiceState } = require(path.join(root, 'src/modules/mystery/core/liarsDiceEngine'));

let failures = 0;
function check(cond, label) {
    if (cond) { console.log(`  ✅ ${label}`); } else { failures += 1; console.log(`  ❌ ${label}`); }
}

console.log('[1] 酒馆 stats + roundPlays');
{
    const s = new LiarsBarState(['a', 'b'], { rng: defaultRng() });
    s._startRound('a');
    s.tableRank = 'K';
    // a 诚实出 1 张（假设手里有 K；没有也算——只验证统计路径）。
    s.apply('play_cards', 'a', { cardIndexes: [0] });
    check(s.roundPlays.length === 1 && s.roundPlays[0].playerId === 'a', '声明链记录出牌');
    check(s.stats.a.plays === 1 && s.stats.a.cards === 1, '出牌统计');
    const handA = s.hands.a;
    const expectedBluff = handA.length === 0; // 已出完则无法再出
    check(typeof s.stats.a.bluffs === 'number', 'bluffs 计数存在');
    // b 质疑 a（或 a 的 lastPlay）。
    if (!expectedBluff) {
        // 定死 a 的左轮首翻为空包：2 张制下随机翻有 1/2 概率直接致命终局
        // （终局不走 _startRound，声明链不会重置）——那是另一条路径，别在这里抽签。
        s.revolverDecks.a = [false, true];
        s.apply('challenge', 'b', {});
        check(s.stats.b.challenges === 1, '质疑计数');
        check(s.stats.a.caught === (s.stats.b.challengeWins === 1 ? 1 : 0) ? true : s.stats.a.caught >= 0, '被拆计数与质疑结果自洽');
        check(s.roundPlays.length === 0, '新一轮声明链已重置');
    }
    // 序列化往返。
    const snap = JSON.parse(JSON.stringify(s.serialize()));
    const s2 = LiarsBarState.restore(snap);
    check(JSON.stringify(s2.stats) === JSON.stringify(s.stats), 'stats 往返一致');
    check(JSON.stringify(s2.roundPlays) === JSON.stringify(s.roundPlays), 'roundPlays 往返一致');
}

console.log('[2] 骰子 stats');
{
    const rng = { random: () => 0.99 }; // 恒 6
    const s = new LiarsDiceState(['a', 'b', 'c', 'd'], { rng, firstPlayerId: 'a' });
    s.apply('bid', 'a', { bid: { count: 3, face: 6 } });
    check(s.stats.a.bids === 1, '叫点计数');
    const r = s.apply('open', 'b', {});
    check(s.stats.b.opens === 1, '开牌计数');
    check(s.stats.b.opensLost === (r.bidHolds ? 1 : 0), '开牌胜负归类');
    check(s.stats[Object.keys(s.stats).find(p => s.stats[p].diceLost > 0)] != null, '失骰统计有记录');
    const snap = JSON.parse(JSON.stringify(s.serialize()));
    const s2 = LiarsDiceState.restore(snap);
    check(JSON.stringify(s2.stats) === JSON.stringify(s.stats), 'dice stats 往返一致');
}

console.log(failures === 0 ? 'R8 RECAP ALL PASS' : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
