// R11 专项：左轮 2 张制（1/2→必死）+ 明牌池 revealedPool + 单局称号（酒馆 7 / 骰子 6）。
// 运行：node reviews/r11_titles_revolver.cjs
'use strict';
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {
    LiarsBarState, defaultRng,
} = require(path.join(root, 'src/modules/mystery/core/liarsBarEngine'));
const {
    LiarsDiceState,
} = require(path.join(root, 'src/modules/mystery/core/liarsDiceEngine'));

let failures = 0;
function check(cond, label) {
    if (cond) { console.log(`  ✅ ${label}`); } else { failures += 1; console.log(`  ❌ ${label}`); }
}
function hasTitle(result, pid, key) {
    return (result?.titles || []).some(t => t.playerId === pid && t.key === key);
}
const A5 = () => ['A', 'A', 'A', 'A', 'A'];
const Q5 = () => ['Q', 'Q', 'Q', 'Q', 'Q'];

// ── 酒馆：左轮 2 张制 ────────────────────────────────────────────────────────
console.log('── 左轮 2 张制 ──');
{
    const s = new LiarsBarState(['a', 'b'], { rng: defaultRng() });
    check(s.revolverDecks.a.length === 2, '左轮牌堆 = 2 张');
    check(Math.abs(s.lethalOdds('a') - 0.5) < 1e-9, '首翻致命率 = 1/2');
    s.revolverDecks.a = [false, true]; // 定死：a 首翻空包
    s.tableRank = 'A';
    s.lastPlay = { playerId: 'b', cards: ['A'], count: 1 }; // b 诚实
    const r0 = s.apply('challenge', 'a', {});
    check(r0.pardonedChallenge === true && r0.revolverFlips.length === 0, '首次失手豁免不翻左轮');
    s.tableRank = 'Q';
    s.lastPlay = { playerId: 'b', cards: ['Q'], count: 1 };
    const r1 = s.apply('challenge', 'a', {});
    check(r1.liar === false && !r1.pardonedChallenge, '第二次失手翻左轮');
    check(r1.lethal === false, '首翻 = 空包（50% 赌赢）');
    check(s.lethalOdds('a') === 1, '空包后剩余必为致命 → 中弹率必死');
    s.tableRank = 'K';
    s.lastPlay = { playerId: 'b', cards: ['K'], count: 1 };
    const r2 = s.apply('challenge', 'a', {});
    check(r2.lethal === true, '同一人第二次赌输 → 必死');
    check(r2.eliminatedId === 'a', '空包侥幸后下次赌输即出局');
}

// ── 酒馆：非酋 / 欧皇 / 神枪手 / 活靶子 / 赌狗（lastPlay 注入式挑战流） ──────
console.log('── 酒馆称号（挑战流） ──');
{
    // 非酋：首翻即致命。
    const s1 = new LiarsBarState(['a', 'b'], { rng: defaultRng() });
    s1.revolverDecks.a = [true, false];
    s1.tableRank = 'A';
    s1.lastPlay = { playerId: 'a', cards: ['K'], count: 1 };
    const r = s1.apply('challenge', 'b', {});
    check(r.lethal === true && r.eliminatedId === 'a', '首翻即致命出局');
    check(hasTitle(r, 'a', 'feiqiu'), '非酋：首翻即死当场达成');
    check(r.gameEnded && r.winnerId === 'b', '2 人局随致命终局');

    // 欧皇 / 神枪手 / 活靶子。
    const s2 = new LiarsBarState(['a', 'b'], { rng: defaultRng() });
    s2.revolverDecks.a = [false, true];
    s2.revolverDecks.b = [false, true];
    s2.tableRank = 'A';
    s2.lastPlay = { playerId: 'a', cards: ['K'], count: 1 };
    const r1 = s2.apply('challenge', 'b', {});
    check(hasTitle(r1, 'a', 'ouhuang'), '欧皇：对半赌赢当场达成');
    s2.tableRank = 'A';
    s2.lastPlay = { playerId: 'b', cards: ['K'], count: 1 };
    const r2 = s2.apply('challenge', 'a', {});
    check(!hasTitle(r2, 'a', 'shenqiangshou'), '质疑命中 1 次未达神枪手');
    s2.tableRank = 'A';
    s2.lastPlay = { playerId: 'b', cards: ['K'], count: 1 };
    const r3 = s2.apply('challenge', 'a', {});
    check(hasTitle(r3, 'a', 'shenqiangshou'), '神枪手：质疑命中 2 次达成');
    check(hasTitle(r3, 'b', 'huobazi'), '活靶子：被拆穿 2 次达成');
}

// 赌狗：第一手动作就是质疑。
{
    const s = new LiarsBarState(['a', 'b'], { rng: defaultRng() });
    s.tableRank = 'A';
    s.lastPlay = { playerId: 'a', cards: ['A'], count: 1 }; // a 直接注入（未算动作）
    const r = s.apply('challenge', 'b', {}); // b 的第一个动作 = 质疑
    check(r.pardonedChallenge === true, '赌狗质疑诚实手牌 → 首失豁免');
    check(hasTitle(r, 'b', 'dugou'), '赌狗：开局第一手就拍桌达成');
    check(s.stats.b.firstAction === 'challenge', 'firstAction 记录为 challenge');
    check(s.stats.a?.firstAction == null, '注入 lastPlay 不算 a 的动作');
    // 再次质疑不重复播报。
    s.tableRank = 'A';
    s.lastPlay = { playerId: 'a', cards: ['A'], count: 1 };
    const r2 = s.apply('challenge', 'b', {});
    check(!hasTitle(r2, 'b', 'dugou'), '称号只播报一次（announcedTitles 去重）');
    check((s.failedChallenges.b || 0) === 2, '第二次失手不再豁免');
}

// ── 酒馆：影帝 / 龟仙人（完整出牌流，4 人局）+ 明牌池 + 序列化 ───────────────
console.log('── 酒馆称号（出牌流）+ 明牌池 ──');
{
    const s = new LiarsBarState(['a', 'b', 'c', 'd'], { rng: defaultRng() });
    s.revolverDecks = { a: [false, true], b: [false, true], c: [false, true], d: [false, true] };
    s.revolverPointers = { a: 0, b: 0, c: 0, d: 0 };
    const resetRound = (bHand) => {
        s.hands = { a: A5(), b: bHand || Q5(), c: A5(), d: A5() };
        s.tableRank = 'A';
    };

    // R1（先手 a）：a→b(吹牛#1)→c→d，a 强制质疑 d 的诚实手 → 失手豁免。
    resetRound();
    s.turnPlayerId = 'a';
    s.apply('play_cards', 'a', { cardIndexes: [0] });
    s.apply('play_cards', 'b', { cardIndexes: [0] });
    s.apply('play_cards', 'c', { cardIndexes: [0] });
    s.apply('play_cards', 'd', { cardIndexes: [0] });
    const rR1 = s.apply('challenge', 'a', {});
    check(rR1.pardonedChallenge === true, 'R1：a 强制开 d 的诚实手，首失豁免');
    check(s.stats.b.bluffs === 1, 'R1：b 撒谎 1 手');
    check(rR1.firstPlayerId === 'b', 'R2 先手 = 输家 a 的下家 b');

    // R2（先手 b）：b(吹牛#2)→c→d→a，b 强制开 a 的诚实手 → 豁免。
    resetRound();
    s.turnPlayerId = 'b';
    s.apply('play_cards', 'b', { cardIndexes: [0] });
    s.apply('play_cards', 'c', { cardIndexes: [0] });
    s.apply('play_cards', 'd', { cardIndexes: [0] });
    s.apply('play_cards', 'a', { cardIndexes: [0] });
    const rR2 = s.apply('challenge', 'b', {});
    check(rR2.pardonedChallenge === true, 'R2：b 强制开 a 的诚实手，首失豁免');
    check(s.stats.b.bluffs === 2, 'R2：b 撒谎 2 手');

    // R3（先手 c）：c→d→a→b 出真牌避抓。
    resetRound(['A', 'A', 'Q', 'Q', 'Q']);
    s.turnPlayerId = 'c';
    s.apply('play_cards', 'c', { cardIndexes: [0] });
    s.apply('play_cards', 'd', { cardIndexes: [0] });
    s.apply('play_cards', 'a', { cardIndexes: [0] });
    s.apply('play_cards', 'b', { cardIndexes: [0] }); // A 诚实
    const rR3 = s.apply('challenge', 'c', {});
    check(rR3.pardonedChallenge === true, 'R3：c 强制开 b 的诚实手，豁免');
    check(s.stats.b.caught === 0, 'b 从未被拆穿');

    // R4（先手 d）：d→a→b(吹牛#3) → 影帝达成。
    resetRound();
    s.turnPlayerId = 'd';
    s.apply('play_cards', 'd', { cardIndexes: [0] });
    s.apply('play_cards', 'a', { cardIndexes: [0] });
    const rR4 = s.apply('play_cards', 'b', { cardIndexes: [0] });
    check(hasTitle(rR4, 'b', 'yingdi'), '影帝：撒谎 3 手从未被抓（第 3 手当场达成）');
    s.apply('play_cards', 'c', { cardIndexes: [0] });
    const rR4end = s.apply('challenge', 'd', {});
    check(rR4end.pardonedChallenge === true, 'R4：d 强制开 c 的诚实手，豁免');

    // R5（先手 a）：a 第 5 手诚实出牌 → 龟仙人。
    resetRound();
    s.turnPlayerId = 'a';
    const rR5 = s.apply('play_cards', 'a', { cardIndexes: [0] });
    check(s.stats.a.plays === 5 && s.stats.a.bluffs === 0 && s.stats.a.caught === 0, 'a 五手全真从未被抓');
    check(hasTitle(rR5, 'a', 'guixianren'), '龟仙人：五手全真达成');

    // 明牌池：4 次质疑各翻 1 张 A。
    check(s.revealedPool.length === 4 && s.revealedCount('A') === 4, '明牌池累计 4 次开牌的 A×4');
    check(s.revealedCount('Q') === 0 && s.revealedCount('JOKER') === 0, '明牌池按点数分计');

    // 序列化往返：revealedPool / announcedTitles / stats.firstAction。
    const snap = JSON.parse(JSON.stringify(s.serialize()));
    const s2 = LiarsBarState.restore(snap);
    check(JSON.stringify(s2.revealedPool) === JSON.stringify(s.revealedPool), 'revealedPool 序列化往返一致');
    check(JSON.stringify(s2.announcedTitles) === JSON.stringify(s.announcedTitles), 'announcedTitles 序列化往返一致');
    check(s2.stats.b.firstAction === 'play' && s2.titlesOf('b').some(t => t.key === 'yingdi'), '恢复后称号查询可用');

    // 旧快照（无新字段）恢复不炸。
    const oldSnap = JSON.parse(JSON.stringify(snap));
    delete oldSnap.revealedPool; delete oldSnap.announcedTitles;
    const s3 = LiarsBarState.restore(oldSnap);
    check(s3.revealedPool.length === 0 && Object.keys(s3.announcedTitles).length === 0 && s3.legacyTitles === true, '旧快照恢复 → 空明牌池/称号 + legacyTitles 静默');
}

// ── 骰子：六称号 ─────────────────────────────────────────────────────────────
console.log('── 骰子称号 ──');
{
    // 神算子：精准开牌命中。
    const s1 = new LiarsDiceState(['a', 'b', 'c', 'd'], { rng: defaultRng() });
    s1.dice = { a: [2, 2, 1], b: [1, 1, 3], c: [5, 5, 5], d: [2, 2, 2] };
    s1.turnPlayerId = 'a';
    s1.apply('bid', 'a', { bid: { count: 8, face: 2 } });
    const r = s1.apply('spot_on', 'b', {});
    check(r.spotOn === true, '精准开牌命中（2s×5 + 万能×3 = 8）');
    check(hasTitle(r, 'b', 'shensuanzi'), '神算子：精准命中达成');
    check(JSON.stringify(r.spotOnVictims) === JSON.stringify(['a', 'c', 'd']), '命中 → 除自己外全场失骰');

    // 梭哈鬼才：两次精准全失手（失手冷却一轮：第 2 轮禁梭哈，第 3 轮解禁）。
    // ⚠️ 引擎每轮 _startRound 会重掷全部骰子——跨轮场景必须在轮次边界重注定值。
    const s2 = new LiarsDiceState(['a', 'b', 'c', 'd'], { rng: defaultRng() });
    s2.dice = { a: [3, 3, 3], b: [3, 3, 3], c: [3, 3, 3], d: [3, 3, 3] };
    s2.turnPlayerId = 'a';
    s2.apply('bid', 'a', { bid: { count: 5, face: 2 } });
    s2.apply('spot_on', 'b', {}); // 全场无 2 无 1 → 失手
    check(s2.stats.b.spotOnTries === 1 && s2.spotOnCooldown === 'b', '失手 1 次，冷却挂入下一轮');
    // 第 2 轮（b 先手，重注：b 失手后剩 2 骰）：b 普通开牌过渡（0 个 2 → 开牌必赢）。
    s2.dice = { a: [3, 3, 3], b: [3, 3], c: [3, 3, 3], d: [3, 3, 3] };
    s2.apply('bid', 'b', { bid: { count: 2, face: 2 } });
    s2.apply('bid', 'c', { bid: { count: 3, face: 2 } });
    s2.apply('bid', 'd', { bid: { count: 4, face: 2 } });
    s2.apply('bid', 'a', { bid: { count: 5, face: 2 } });
    s2.apply('open', 'b', {}); // 5 个 2 实际 0 个 → 不成立 → b 赢，a 失 1 骰
    // 第 3 轮（输家 a 先手，重注：a/b 各剩 2 骰）：b 再梭哈 → 失手第 2 次。
    s2.dice = { a: [3, 3], b: [3, 3], c: [3, 3, 3], d: [3, 3, 3] };
    s2.apply('bid', 'a', { bid: { count: 2, face: 2 } });
    s2.apply('bid', 'b', { bid: { count: 3, face: 2 } });
    s2.apply('bid', 'c', { bid: { count: 4, face: 2 } });
    s2.apply('bid', 'd', { bid: { count: 5, face: 2 } });
    s2.apply('bid', 'a', { bid: { count: 6, face: 2 } });
    const r2 = s2.apply('spot_on', 'b', {});
    check(hasTitle(r2, 'b', 'suoha'), '梭哈鬼才：两次精准零命中达成');
    check(s2.stats.b.diceLost === 2 && s2.stats.b.opensWon === 1, '两次失手各失 1 骰');

    // 莽夫：开牌判错两次（叫点成立，开牌者输）。
    const s3 = new LiarsDiceState(['a', 'b', 'c', 'd'], { rng: defaultRng() });
    s3.dice = { a: [2, 2, 2, 2, 2], b: [3, 3, 3, 3, 3], c: [3, 3, 3, 3, 3], d: [3, 3, 3, 3, 3] };
    s3.turnPlayerId = 'a';
    s3.apply('bid', 'a', { bid: { count: 3, face: 2 } }); // 实际 5 个 2 → 成立
    s3.apply('open', 'b', {}); // b 判错失 1 骰
    check(s3.stats.b.opensLost === 1, '莽夫：开牌判错 1 次');
    // R2（输家 b 先手，重注：a 仍 5 个 2、b 剩 4 骰）：b{1,2}→c{2,2}→d{3,2}→a{4,2}（成立）→ b 开牌再判错。
    s3.dice = { a: [2, 2, 2, 2, 2], b: [3, 3, 3, 3], c: [3, 3, 3, 3, 3], d: [3, 3, 3, 3, 3] };
    s3.apply('bid', 'b', { bid: { count: 1, face: 2 } });
    s3.apply('bid', 'c', { bid: { count: 2, face: 2 } });
    s3.apply('bid', 'd', { bid: { count: 3, face: 2 } });
    s3.apply('bid', 'a', { bid: { count: 4, face: 2 } });
    const r3 = s3.apply('open', 'b', {});
    check(r3.bidHolds === true && hasTitle(r3, 'b', 'mangfu'), '莽夫：开牌判错 2 次达成');

    // 骨灰级玩家：第一个出局。
    const s5 = new LiarsDiceState(['a', 'b', 'c', 'd'], { rng: defaultRng() });
    s5.dice = { a: [1], b: [3, 3, 3], c: [3, 3, 3], d: [3, 3, 3] };
    s5.turnPlayerId = 'a';
    s5.apply('bid', 'a', { bid: { count: 2, face: 2 } }); // 实际 1（a 的万能 1）→ 不成立
    const r5 = s5.apply('open', 'b', {});
    check(r5.eliminatedId === 'a' && s5.eliminationOrder[0] === 'a', 'a 首个出局');
    check(hasTitle(r5, 'a', 'guhui'), '骨灰级玩家：第一个出局达成');

    // F3 回归：从未行动就认输的首个出局者（无 stats）也能领「骨灰级玩家」。
    const s5b = new LiarsDiceState(['a', 'b', 'c', 'd'], { rng: defaultRng() });
    s5b.turnPlayerId = 'a';
    const r5b = s5b.applyForfeit('a');
    check(s5b.stats.a == null && hasTitle(r5b, 'a', 'guhui'), '骨灰级：从未行动的认输首个出局者达成');

    // 命硬：赢家只剩 1 颗骰（每轮边界重注定值骰）。
    const s6 = new LiarsDiceState(['a', 'b', 'c', 'd'], { rng: defaultRng() });
    s6.dice = { a: [1], b: [1], c: [1], d: [3] };
    s6.turnPlayerId = 'a';
    s6.apply('bid', 'a', { bid: { count: 4, face: 2 } }); // 万能×3 < 4 → 不成立 → a 出局
    const r6a = s6.apply('open', 'b', {});
    check(hasTitle(r6a, 'a', 'guhui'), '骨灰级玩家（命硬局顺手验证）');
    s6.dice = { a: [], b: [1], c: [1], d: [3] }; // R2 重注
    s6.apply('bid', 'b', { bid: { count: 3, face: 2 } }); // 万能×1(c) < 3 → b 出局
    s6.apply('open', 'c', {});
    s6.dice = { a: [], b: [], c: [1], d: [3] }; // R3 重注
    s6.apply('bid', 'c', { bid: { count: 2, face: 2 } }); // 场上仅剩 2 骰；万能 0 < 2
    const r6b = s6.apply('open', 'd', {});
    check(r6b.gameEnded === true && s6.winnerId === 'd', '三连开牌清场，d 险胜');
    check(hasTitle(r6b, 'd', 'mingying'), '命硬：仅剩 1 颗骰躺赢达成');

    // 铁嘴：开牌成功两次（R2 边界重注）。
    const s7 = new LiarsDiceState(['a', 'b', 'c', 'd'], { rng: defaultRng() });
    s7.dice = { a: [3, 3, 3], b: [3, 3, 3], c: [3, 3, 3], d: [3, 3, 3] };
    s7.turnPlayerId = 'a';
    s7.apply('bid', 'a', { bid: { count: 5, face: 2 } });
    s7.apply('open', 'b', {}); // 不成立 → b 赢 1 次，a 失 1 骰
    // R2（输家 a 先手，重注：a 剩 2 骰）：a 再吹假点 → b 开牌再赢。
    s7.dice = { a: [3, 3], b: [3, 3, 3], c: [3, 3, 3], d: [3, 3, 3] };
    s7.apply('bid', 'a', { bid: { count: 5, face: 2 } });
    const r7 = s7.apply('open', 'b', {}); // 实际 0 个 2 → 不成立 → b 赢 2 次
    check(s7.stats.b.opensWon === 2 && hasTitle(r7, 'b', 'tiezui'), '铁嘴：开牌成功 2 次达成');

    // 骰子序列化往返 + 旧快照（legacyTitles 静默止血）。
    const snap = JSON.parse(JSON.stringify(s7.serialize()));
    const s8 = LiarsDiceState.restore(snap);
    check(JSON.stringify(s8.announcedTitles) === JSON.stringify(s7.announcedTitles) && !s8.legacyTitles, '骰子 announcedTitles 往返一致');
    const oldSnap = JSON.parse(JSON.stringify(snap));
    delete oldSnap.announcedTitles; delete oldSnap.eliminationOrder;
    const s9 = LiarsDiceState.restore(oldSnap);
    check(Object.keys(s9.announcedTitles).length === 0 && s9.eliminationOrder.length === 0 && s9.legacyTitles === true, '骰子旧快照恢复 → legacyTitles 静默');
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
