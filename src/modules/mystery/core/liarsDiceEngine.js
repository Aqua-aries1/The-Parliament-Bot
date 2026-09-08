/**
 * 骗子骰子（Liar's Dice）纯状态机（CommonJS，零依赖，可注入 rng 复现）。
 *
 * 规则（4-8 人）：
 *   - 每人起手 5 颗骰子，暗掷（只有自己可见）；
 *   - 轮流叫点：声称「全场至少有 X 个 Y 点」；每次叫点必须比上一手更激进——
 *     数量更多，或同数量点数更大；1 点是万能（开牌数骰时 1 与被叫点数都计入），
 *     但 1 不能被叫（经典规则，防止万能点自我循环）；
 *   - 轮到你：加注（叫更狠）、开牌（质疑上一手）或精准开牌（喊「正好 X 个 Y」）；
 *   - 开牌：全场数骰（被叫点数 + 万能 1）。数量够 → 叫点者赢、开牌者输 1 骰；
 *     不够 → 叫点者输 1 骰；
 *   - 精准开牌（Spot On）：针对当前叫点喊「正好就是这么多」。
 *     正好 → 除自己外全场各失 1 骰（高回报）；不正好 → 自己失 1 骰（高风险）；
 *   - 输家先手开新一轮（骰子重新掷）；骰子归零者出局；
 *   - 仅剩 1 人存活即获胜。
 *
 * 所有回合不变量都在这里维护；Discord 交互层只允许调用 apply() 并渲染返回的状态，
 * 不得直接改 dice/turnPlayerId/alive。
 */

const DICE_SIDES = 6;
const WILD_FACE = 1;      // 万能面
const MIN_FACE = 2;       // 可叫的最小点数（1 不可叫）
// 起手骰随人数递减：人越多局越长（40 骰全消耗要 37+ 轮），压缩总量控制 Discord
// 异步节奏——4 人 5 骰（经典）、5-6 人 4 骰、7-8 人 3 骰，全场总量守恒在 20-24。
const START_DICE_BY_PLAYERS = Object.freeze({ 4: 5, 5: 4, 6: 4, 7: 3, 8: 3 });
const DEFAULT_START_DICE = 4;

class InvalidAction extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidAction';
    }
}

function assert(cond, msg) {
    if (!cond) throw new InvalidAction(msg);
}

function defaultRng() {
    return {
        random: Math.random,
        randint: (a, b) => a + Math.floor(Math.random() * (b - a + 1)),
    };
}

// 默认值全字段齐全的稠密结果对象（交互层可放心读取任意字段）。
function defaultActionResult(action, actorId) {
    return {
        action, actorId,
        bid: null,               // 本次叫点 { count, face }（bid）
        calledBid: null,         // 被开牌的叫点 { count, face, playerId }（open/spot_on）
        bidHolds: null,          // 开牌结论：叫点成立与否（open）
        revealedDice: {},        // 开牌时全场明示的骰子 playerId -> [faces]（open）
        totalCalled: null,       // 开牌统计：被叫点数（含万能 1）实际总数（open）
        loserId: null,           // 本轮输家（open）
        eliminatedId: null,      // 出局者（骰子归零）
        newRound: false,         // 是否开了新一轮
        firstPlayerId: null,     // 新一轮先手（newRound 时非空）
        gameEnded: false,
        winnerId: null,
        spotOn: null,            // 精准开牌结论：是否正好（spot_on）
        spotOnVictims: [],       // 精准开牌命中时失骰的玩家列表（spot_on）
        eliminatedIds: [],       // 本手全部出局者（多人同时归零时 &gt;1 个；eliminatedId 为首个）
    };
}

class LiarsDiceState {
    constructor(playerIds, { rng = null, firstPlayerId = null } = {}) {
        const unique = [...new Set(playerIds)];
        assert(unique.length >= 4 && unique.length <= 8, '骗子骰子需要 4-8 名玩家');
        this.rng = rng || defaultRng();
        this.players = unique; // 座位顺序 = 加入顺序，回合沿此循环
        this.phase = 'playing';
        this.winnerId = null;
        this.dice = {};         // pid -> 骰面数组（长度 = 剩余骰子数）
        this.alive = new Set(unique);
        this.currentBid = null; // { playerId, count, face } 或 null（本轮尚未叫点）
        this.turnPlayerId = null;
        this.turnToken = 0;
        this.roundNumber = 0;
        this.spotOnCooldown = null; // spot_on 失手者冷却一轮
        this.stats = {};            // playerId -> 本局统计（复盘用，纯内存）
        const startDice = START_DICE_BY_PLAYERS[unique.length] ?? DEFAULT_START_DICE;
        for (const pid of unique) this.dice[pid] = new Array(startDice).fill(1);
        const first = firstPlayerId != null && unique.includes(firstPlayerId)
            ? firstPlayerId
            : unique[Math.floor(this.rng.random() * unique.length)];
        this._startRound(first);
    }

    // ── 派生状态 ──

    get currentPlayerId() {
        return this.phase === 'ended' ? null : this.turnPlayerId;
    }

    // 当前必须开牌：上一手就是自己叫的（无人可质疑自己的叫点，只能加注或——
    // 若无人能再加注——规则上不可能出现：数量总能往上抬）。
    get mustOpen() {
        return false;
    }

    diceText(playerId) {
        const faces = this.dice[playerId] || [];
        return faces.length ? faces.join(' ') : '（无骰）';
    }

    diceCount(playerId) {
        return (this.dice[playerId] || []).length;
    }

    totalDice() {
        return this.players.reduce((sum, pid) => sum + (this.alive.has(pid) ? this.diceCount(pid) : 0), 0);
    }

    // 叫点是否比 currentBid 更激进：数量更多，或同数量点数更大。
    isLegalBid(count, face) {
        if (!Number.isInteger(count) || count < 1) return false;
        if (!Number.isInteger(face) || face < MIN_FACE || face > DICE_SIDES) return false;
        if (count > this.totalDice()) return false; // 超过全场骰子总数的叫点无意义
        const bid = this.currentBid;
        if (bid == null) return true;
        return count > bid.count || (count === bid.count && face > bid.face);
    }

    // 合法加注空间（UI 生成选项用）：全部 (count, face) 组合中的合法子集上限。
    legalBidLimit() {
        const bid = this.currentBid;
        if (bid == null) return { maxCount: this.totalDice() };
        return { maxCount: this.totalDice(), prev: bid };
    }

    // ── 轮次 ──

    _startRound(firstPlayerId) {
        this.roundNumber += 1;
        this.currentBid = null;
        this.spotOnCooldown = null; // 新一轮解除精准开牌冷却
        for (const pid of this.players) {
            if (!this.alive.has(pid)) { this.dice[pid] = []; continue; }
            const n = this.diceCount(pid);
            const faces = [];
            for (let i = 0; i < n; i++) {
                faces.push(1 + Math.floor(this.rng.random() * DICE_SIDES));
            }
            this.dice[pid] = faces;
        }
        let first = firstPlayerId;
        if (!this.alive.has(first)) first = this._nextAlive(first) || first;
        this.turnPlayerId = first;
    }

    _nextAlive(fromPlayerId) {
        const start = this.players.indexOf(fromPlayerId);
        assert(start !== -1, '玩家不在本局中。');
        for (let step = 1; step <= this.players.length; step++) {
            const pid = this.players[(start + step) % this.players.length];
            if (this.alive.has(pid)) return pid;
        }
        return null;
    }

    _advanceTurn(afterPlayerId) {
        const next = this._nextAlive(afterPlayerId);
        this.turnPlayerId = next != null ? next : afterPlayerId;
    }

    // ── 合法性判断 ──

    canBid(userId, count, face) {
        if (this.phase !== 'playing' || userId !== this.turnPlayerId) return false;
        return this.isLegalBid(count, face);
    }

    // 开牌：轮到者即可质疑上一手（第一手无人可质疑）。
    canOpen(userId) {
        if (this.phase !== 'playing' || userId !== this.turnPlayerId) return false;
        return this.currentBid != null;
    }

    // 精准开牌：开牌资格 + 未在冷却（上一手 spot_on 失手者冷却一轮，堵连续梭哈）。
    canSpotOn(userId) {
        if (!this.canOpen(userId)) return false;
        return this.spotOnCooldown == null || this.spotOnCooldown !== userId;
    }

    // ── 入口 ──

    apply(action, actorId, { expectedToken = null, bid = null } = {}) {
        assert(this.phase !== 'ended', '这局已经结束了。');
        if (expectedToken != null) assert(expectedToken === this.turnToken, '这个按钮已经过期，请看最新面板。');
        assert(actorId === this.turnPlayerId, '现在还没轮到你。');
        assert(this.alive.has(actorId), '你已经出局了。');

        let result;
        if (action === 'bid') result = this._bid(actorId, bid);
        else if (action === 'open') result = this._open(actorId);
        else if (action === 'spot_on') result = this._spotOn(actorId);
        else throw new InvalidAction('未知操作。');
        this.turnToken += 1;
        return result;
    }

    _bid(actorId, bid) {
        const count = bid?.count;
        const face = bid?.face;
        assert(this.canBid(actorId, count, face), '这个叫点不合法：必须比上一手更狠（数量更多，或同数量点数更大；1 不可叫）。');
        this.currentBid = { playerId: actorId, count, face };
        this._stat(actorId).bids += 1;
        this._advanceTurn(actorId);
        const result = defaultActionResult('bid', actorId);
        result.bid = { count, face };
        return result;
    }

    // 全场数骰（被叫点数 + 万能 1），返回 { total, revealed }。
    _countDice(called) {
        let total = 0;
        const revealed = {};
        for (const pid of this.players) {
            if (!this.alive.has(pid)) continue;
            const faces = this.dice[pid];
            revealed[pid] = [...faces];
            total += faces.filter(f => f === called.face || f === WILD_FACE).length;
        }
        return { total, revealed };
    }

    // 单人失 1 骰；归零出局（不在此处终局判定）。返回 是否出局。
    _stat(pid) {
        if (!this.stats[pid]) {
            this.stats[pid] = { bids: 0, opens: 0, opensWon: 0, opensLost: 0, spotOnTries: 0, spotOnHits: 0, diceLost: 0 };
        }
        return this.stats[pid];
    }

    _loseDie(playerId) {
        this._stat(playerId).diceLost += 1;
        this.dice[playerId] = (this.dice[playerId] || []).slice(0, -1);
        if (this.diceCount(playerId) > 0) return false;
        this.alive.delete(playerId);
        return true;
    }

    // 全部扣骰完成后统一判定终局。返回 gameEnded。
    _checkGameEnd() {
        if (this.alive.size <= 1) {
            this.phase = 'ended';
            this.winnerId = [...this.alive][0] || null;
            return true;
        }
        return false;
    }

    _open(actorId) {
        assert(this.canOpen(actorId), '现在不能开牌。');
        const called = this.currentBid;
        const { total, revealed } = this._countDice(called);
        // 数量够 → 叫点成立 → 开牌者输；不够 → 叫点者输。
        const bidHolds = total >= called.count;
        let loserId = bidHolds ? actorId : called.playerId;
        // 叫点人已出局（如认输离席后留下的叫点被开）：声明随人作废，无人受罚。
        if (loserId !== actorId && !this.alive.has(loserId)) loserId = null;

        const result = defaultActionResult('open', actorId);
        result.calledBid = { ...called };
        result.revealedDice = revealed;
        result.totalCalled = total;
        result.bidHolds = bidHolds;
        result.loserId = loserId;
        const stO = this._stat(actorId);
        stO.opens += 1;
        if (loserId != null) {
            if (bidHolds) stO.opensLost += 1;
            else stO.opensWon += 1;
        }
        const out = [];
        if (loserId != null && this._loseDie(loserId)) out.push(loserId);
        result.eliminatedIds = out;
        result.eliminatedId = out[0] ?? null;
        if (out.length && this._checkGameEnd()) {
            result.gameEnded = true;
            result.winnerId = this.winnerId;
            return result;
        }
        // 新一轮：输家先手（出局则顺位）；声明作废时由开牌者开新轮。
        this._startRound(loserId ?? actorId);
        result.newRound = true;
        result.firstPlayerId = this.turnPlayerId;
        return result;
    }

    // 精准开牌（Spot On）：针对当前叫点喊「正好就是这么多」。
    // 正好 → 除自己外全场存活者各失 1 骰；不正好 → 自己失 1 骰。
    _spotOn(actorId) {
        assert(this.canSpotOn(actorId), '现在不能精准开牌（上一手失手冷却中）。');
        const called = this.currentBid;
        const { total, revealed } = this._countDice(called);
        const exact = total === called.count;

        const result = defaultActionResult('spot_on', actorId);
        result.action = 'spot_on';
        result.calledBid = { ...called };
        result.revealedDice = revealed;
        result.totalCalled = total;
        result.spotOn = exact;
        const stS = this._stat(actorId);
        stS.spotOnTries += 1;
        if (exact) stS.spotOnHits += 1;
        result.loserId = exact ? null : actorId;
        const lines = [];
        if (exact) {
            for (const pid of this.players) {
                if (pid !== actorId && this.alive.has(pid)) lines.push(pid);
            }
            result.spotOnVictims = lines;
        } else {
            result.spotOnVictims = [];
        }
        // 失骰结算：逐个扣骰，收集全部出局者，最后统一判终局。
        const losers = exact ? lines : [actorId];
        const out = [];
        for (const pid of losers) {
            if (this._loseDie(pid)) out.push(pid);
        }
        result.eliminatedIds = out;
        result.eliminatedId = out[0] ?? null;
        if (out.length && this._checkGameEnd()) {
            result.gameEnded = true;
            result.winnerId = this.winnerId;
            return result;
        }
        // 新一轮先手：不正好 → 自己；正好 → 出局者外的首位被罚者（由 _startRound 顺位兜底）。
        const first = exact ? (lines.find(p => !out.includes(p)) ?? actorId) : actorId;
        this._startRound(first);
        if (!exact) this.spotOnCooldown = actorId; // 失手冷却一轮（在 _startRound 后挂，否则被清掉）
        result.newRound = true;
        result.firstPlayerId = this.turnPlayerId;
        return result;
    }

    // 认输 / 成员失格：直接出局。
    applyForfeit(actorId) {
        assert(this.phase !== 'ended', '这局已经结束了。');
        assert(this.players.includes(actorId) && this.alive.has(actorId), '该玩家不在本局或已出局。');
        const result = defaultActionResult('forfeit', actorId);
        result.loserId = actorId;
        result.eliminatedId = actorId;
        this.alive.delete(actorId);
        this.dice[actorId] = [];
        if (this.alive.size <= 1) {
            this.phase = 'ended';
            this.winnerId = [...this.alive][0] || null;
            result.gameEnded = true;
            result.winnerId = this.winnerId;
            return result;
        }
        if (this.turnPlayerId === actorId) {
            const next = this._nextAlive(actorId);
            this.turnPlayerId = next != null ? next : this.turnPlayerId;
        }
        this.turnToken += 1;
        return result;
    }

    // ── 快照（断连接续） ──

    serialize() {
        return {
            players: this.players,
            phase: this.phase,
            winnerId: this.winnerId,
            dice: this.dice,
            alive: [...this.alive],
            currentBid: this.currentBid,
            turnPlayerId: this.turnPlayerId,
            turnToken: this.turnToken,
            roundNumber: this.roundNumber,
            spotOnCooldown: this.spotOnCooldown,
            stats: this.stats,
        };
    }

    static restore(data) {
        const s = new LiarsDiceState(data.players, { rng: defaultRng() });
        s.phase = data.phase;
        s.winnerId = data.winnerId ?? null;
        s.dice = data.dice || {};
        s.alive = new Set(data.alive || data.players);
        s.currentBid = data.currentBid || null;
        s.turnPlayerId = data.turnPlayerId;
        s.turnToken = data.turnToken || 0;
        s.roundNumber = data.roundNumber || 1;
        s.spotOnCooldown = data.spotOnCooldown ?? null;
        s.stats = data.stats || {};
        return s;
    }
}

module.exports = {
    LiarsDiceState,
    InvalidAction,
    defaultRng,
    DICE_SIDES,
    WILD_FACE,
    MIN_FACE,
    START_DICE_BY_PLAYERS,
    DEFAULT_START_DICE,
};
