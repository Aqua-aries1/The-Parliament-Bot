// 骗子酒馆自玩模拟器：策略 bot 打完整局，输出牌谱与统计。
// 策略：诚实优先（有真牌出真牌，1-3 张按持有量），无真牌时按吹牛率 bluffRate 撒谎；
//       质疑决策：基于上一手张数的启发（出得越多越可疑）+ 基础质疑率。
// 运行：node liarsbar_sim.cjs [局数] [玩家数]
'use strict';
const path = require('node:path');
const root = path.resolve(__dirname);
const { LiarsBarState, JOKER } = require(path.join(root, 'src/modules/mystery/core/liarsBarEngine'));

const GAMES = Number(process.argv[2] || 2);
const NPLAYERS = Number(process.argv[3] || 3);

function decide(s, pid) {
    // 返回 {type:'play', indexes} 或 {type:'challenge'}
    if (s.mustChallenge) return { type: 'challenge' };
    const hand = s.handCards(pid);
    if (!hand.length) return { type: 'challenge' };
    if (s.canChallenge(pid) && s.lastPlay != null) {
        const count = s.lastPlay.count;
        // 启发式：上一手张数越多越可疑（一次出 3 张全真的先验低）；
        // 手里真牌越多，越倾向于对方是真牌（同点数牌有限）→ 质疑欲下降。
        const myHonest = hand.filter(c => c === s.tableRank || c === JOKER).length;
        const suspicion = count >= 3 ? 0.55 : count === 2 ? 0.35 : 0.2;
        const adjust = myHonest >= 3 ? -0.15 : myHonest >= 2 ? -0.08 : 0.05;
        if (Math.random() < suspicion + adjust) return { type: 'challenge' };
    }
    const honest = hand.map((c, i) => ({ c, i })).filter(x => x.c === s.tableRank || x.c === JOKER);
    if (honest.length > 0) {
        // 出 1-2 张真牌（留缓冲），全真时多出
        const n = Math.min(honest.length >= 3 ? 2 : 1, honest.length);
        return { type: 'play', indexes: honest.slice(0, n).map(x => x.i) };
    }
    // 无真牌：30% 直接质疑，70% 吹牛 1 张
    if (s.canChallenge(pid) && Math.random() < 0.3) return { type: 'challenge' };
    const idx = Math.floor(Math.random() * hand.length);
    return { type: 'play', indexes: [idx] };
}

function challengerFor(s, cur) {
    // 抢质疑：任何存活非出牌人都可能拍桌（模拟并发抢，随机选一个有动机的）
    if (s.lastPlay == null) return null;
    const candidates = s.players.filter(p => s.alive.has(p) && s.canChallenge(p));
    if (!candidates.length) return null;
    if (Math.random() < 0.25) return candidates[Math.floor(Math.random() * candidates.length)];
    return null;
}

function runGame(verbose, stats) {
    const ids = Array.from({ length: NPLAYERS }, (_, i) => `P${i + 1}`);
    const s = new LiarsBarState(ids, {});
    const log = [];
    let guard = 0;
    while (s.phase !== 'ended' && guard++ < 500) {
        const cur = s.currentPlayerId;
        // 抢质疑机会（在 cur 行动前，其他人 25% 概率拍桌）
        const grabber = challengerFor(s, cur);
        const actor = grabber || cur;
        const decision = grabber ? { type: 'challenge' } : decide(s, cur);
        try {
            if (decision.type === 'challenge' && !s.canChallenge(actor)) continue;
            const before = { hands: s.players.map(p => s.handCards(p).length) };
            const args = decision.type === 'play' ? { cardIndexes: decision.indexes } : {};
            const r = s.apply(decision.type === 'play' ? 'play_cards' : 'challenge', actor, args);
            if (decision.type === 'play') {
                const bluffed = r.playedCards.some(c => c !== s.tableRank && c !== JOKER);
                stats.plays += 1;
                if (bluffed) stats.bluffs += 1;
                if (verbose) log.push(`R${s.roundNumber} ${actor} 出 ${r.playedCards.length} 张${bluffed ? '（吹牛）' : '（诚实）'} 手牌余 ${before.hands[ids.indexOf(actor)] - r.playedCards.length}`);
            } else {
                stats.challenges += 1;
                if (r.liar) stats.caught += 1; else stats.wrongCall += 1;
                stats.revolverFlips += 1;
                if (r.lethal) stats.lethal += 1;
                if (verbose) log.push(`R${s.roundNumber} ${actor} 质疑 ${r.revealedBy} → ${r.liar ? '吹牛成立' : '质疑失败'}，${r.loserId} 翻左轮${r.lethal ? ' 💀致命出局' : ' 空包存活'}`);
                if (r.gameEnded && verbose) log.push(`🏆 终局胜者 ${r.winnerId}（第 ${s.roundNumber} 轮）`);
            }
        } catch (e) {
            if (verbose) log.push(`（${actor} ${decision.type} 被拒：${e.message}）`);
        }
    }
    if (verbose) log.forEach(l => console.log('  ' + l));
    stats.games += 1;
    stats.rounds += s.roundNumber;
    return s.winnerId;
}

const stats = { games: 0, rounds: 0, plays: 0, bluffs: 0, challenges: 0, caught: 0, wrongCall: 0, revolverFlips: 0, lethal: 0 };
// 两局详细牌谱
for (let i = 0; i < 2; i++) {
    console.log(`\n===== 第 ${i + 1} 局（${NPLAYERS} 人）=====`);
    const w = runGame(true, stats);
    console.log(`  胜者：${w}`);
}
// 统计批量（1000 局）
const bulk = { games: 0, rounds: 0, plays: 0, bluffs: 0, challenges: 0, caught: 0, wrongCall: 0, revolverFlips: 0, lethal: 0 };
for (let i = 0; i < 1000; i++) runGame(false, bulk);
console.log('\n===== 1000 局统计 =====');
console.log(`平均轮数/局: ${(bulk.rounds / bulk.games).toFixed(2)}`);
console.log(`平均出牌/局: ${(bulk.plays / bulk.games).toFixed(2)}，其中吹牛占比 ${(bulk.bluffs / bulk.plays * 100).toFixed(1)}%`);
console.log(`平均质疑/局: ${(bulk.challenges / bulk.games).toFixed(2)}（抢质疑含内）`);
console.log(`质疑命中率: ${(bulk.caught / bulk.challenges * 100).toFixed(1)}%（冤枉 ${(bulk.wrongCall / bulk.challenges * 100).toFixed(1)}%）`);
console.log(`左轮翻牌/局: ${(bulk.revolverFlips / bulk.games).toFixed(2)}，致命率 ${(bulk.lethal / bulk.revolverFlips * 100).toFixed(1)}%`);
