// 骗子骰子自玩模拟器：期望外推策略 bot，统计节奏/行为分布/spot_on EV。
// 运行：node liarsdice_sim.cjs [人数] [局数]
'use strict';
const path = require('node:path');
const { LiarsDiceState } = require(path.join(path.resolve(__dirname), 'src/modules/mystery/core/liarsDiceEngine'));

const N = Number(process.argv[2] || 8);
const GAMES = Number(process.argv[3] || 500);

// 期望外推：自己真实骰数 + 其他人骰数 × 1/3（被叫面 + 万能 1 的期望占比 2/6）。
function expectCount(s, pid, face) {
    const mine = (s.dice[pid] || []).filter(f => f === face || f === 1).length;
    const others = s.totalDice() - s.diceCount(pid);
    return mine + others / 3;
}

function runGame(stats) {
    const ids = Array.from({ length: N }, (_, i) => 'p' + i);
    const s = new LiarsDiceState(ids, {});
    let guard = 0;
    while (s.phase !== 'ended' && guard++ < 1000) {
        const cur = s.currentPlayerId;
        const bid = s.currentBid;
        if (bid == null) {
            const face = 2 + Math.floor(Math.random() * 5);
            const expect = expectCount(s, cur, face);
            s.apply('bid', cur, { bid: { count: Math.max(1, Math.round(expect * 0.8)), face } });
            stats.bids += 1;
            continue;
        }
        const expect = expectCount(s, cur, bid.face);
        // 开牌阈值：期望显著低于叫点 → 大概率吹牛 → 开牌。
        if (expect < bid.count - 0.8) {
            s.apply('open', cur, {}); stats.opens += 1; stats.openCalls++;
            stats.openCorrect += (expect < bid.count - 0.8) ? 1 : 0; // 近似
            continue;
        }
        // 精准开牌窗口：期望紧贴叫点时小概率尝试（真人会嗅到"正好"），且需未在冷却期。
        if (s.canSpotOn(cur) && Math.abs(expect - bid.count) <= 0.4 && Math.random() < 0.25) {
            const r = s.apply('spot_on', cur, {});
            stats.spotons += 1;
            if (r.spotOn) stats.spotonHits += 1;
            continue;
        }
        // 加注：跳到期望再上浮（真人不一格一格爬）。
        let nc = Math.max(bid.count + 1, Math.round(expect));
        let nf = nc === bid.count ? bid.face + 1 : bid.face;
        if (nf > 6) { nf = 2; nc += 1; }
        if (nc > s.totalDice() || !s.isLegalBid(nc, nf)) { s.apply('open', cur, {}); stats.opens += 1; continue; }
        s.apply('bid', cur, { bid: { count: nc, face: nf } });
        stats.bids += 1;
    }
    stats.games += 1;
    stats.rounds += s.roundNumber;
}

const stats = { games: 0, rounds: 0, bids: 0, opens: 0, spotons: 0, spotonHits: 0 };
for (let g = 0; g < GAMES; g++) runGame(stats);

console.log(`===== 骗子骰子 ${N} 人局 × ${GAMES} 局 =====`);
console.log(`平均轮数/局: ${(stats.rounds / stats.games).toFixed(1)}`);
console.log(`叫点/局: ${(stats.bids / stats.games).toFixed(1)}　开牌/局: ${(stats.opens / stats.games).toFixed(1)}　精准开牌/局: ${(stats.spotons / stats.games).toFixed(2)}`);
if (stats.spotons > 0) {
    console.log(`精准开牌命中率: ${(stats.spotonHits / stats.spotons * 100).toFixed(1)}%（EV 参考：命中收益=存活人数-1 骰，失手代价=1 骰）`);
}
