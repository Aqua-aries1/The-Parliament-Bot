// R4 平衡改动针对性验证：质疑两振制 + 先手=输家下家 + failedChallenges 序列化。
'use strict';
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { LiarsBarState, defaultRng } = require(path.join(root, 'src/modules/mystery/core/liarsBarEngine'));

let failures = 0;
function check(cond, label) {
    if (cond) { console.log(`  ✅ ${label}`); } else { failures += 1; console.log(`  ❌ ${label}`); }
}

// 2 人局：a、b。
const s = new LiarsBarState(['a', 'b'], { rng: defaultRng() });
s._startRound('a');
// 定死双方左轮牌堆（2 张制首翻 1/2 致命：不钉住会随机死人，断言链崩）。
s.revolverDecks.a = [false, true];
s.revolverDecks.b = [false, true];

// 诚实的一手（b 出 1 张 K，桌面 K）→ a 质疑必失败。
s.tableRank = 'K';
s.lastPlay = { playerId: 'b', cards: ['K'], count: 1 };

const r1 = s.apply('challenge', 'a', {});
check(r1.liar === false, '质疑诚实手牌 = 失败');
check(r1.pardonedChallenge === true, '首次失手 → 两振制豁免');
check(r1.revolverFlips.length === 0, '首次失手不翻左轮');
check(!r1.lethal, '首次失手无致命');
check((s.failedChallenges.a || 0) === 1, '失手计数 = 1');
check(s.revolverPointers.a === 0, '左轮游标未动');
check(r1.loserId === 'a', '输家 = 失手的质疑者 a');
check(r1.firstPlayerId === 'b', '新一轮先手 = 输家(a)的下家(b)');
check(r1.newRound === true, '已开新一轮');

// 第二次失手：不再豁免，翻左轮。
s.tableRank = 'Q';
s.lastPlay = { playerId: 'b', cards: ['Q'], count: 1 };
const ptrBefore = s.revolverPointers.a || 0;
const r2 = s.apply('challenge', 'a', {});
check(r2.liar === false && !r2.pardonedChallenge, '第二次失手不豁免');
check(r2.revolverFlips.length === 1, '第二次失手翻 1 张左轮');
check((s.revolverPointers.a || 0) === ptrBefore + 1, '左轮游标 +1');

// 抓到骗子：骗子翻左轮，与质疑者失手计数无关。
s.tableRank = 'A';
s.lastPlay = { playerId: 'b', cards: ['K'], count: 1 }; // b 吹牛
const ptrBeforeB = s.revolverPointers.b || 0;
const r3 = s.apply('challenge', 'a', {});
check(r3.liar === true, '抓到骗子');
check(r3.pardonedChallenge === undefined || r3.pardonedChallenge === false, '抓骗子不走豁免');
check((s.revolverPointers.b || 0) === ptrBeforeB + 1, '骗子翻左轮（游标 +1）');
check((s.failedChallenges.a || 0) === 2, '质疑者失手计数不变');

// serialize/restore 往返带 failedChallenges。
const snap = JSON.parse(JSON.stringify(s.serialize()));
const s2 = LiarsBarState.restore(snap);
check(JSON.stringify(s2.failedChallenges) === JSON.stringify(s.failedChallenges), 'failedChallenges 序列化往返一致');

// 旧快照（无该字段）恢复不炸。
const oldSnap = JSON.parse(JSON.stringify(snap));
delete oldSnap.failedChallenges;
const s3 = LiarsBarState.restore(oldSnap);
check(s3.failedChallenges && Object.keys(s3.failedChallenges).length === 0, '旧快照恢复 → 空 failedChallenges');

console.log(failures === 0 ? 'TWO-STRIKE ALL PASS' : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
