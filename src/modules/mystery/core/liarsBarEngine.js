/**
 * 骗子酒馆（Liar's Deck）纯状态机（CommonJS，零依赖，可注入 rng 复现）。
 *
 * 规则（对齐原版 Liar's Bar 卡牌模式，2-4 人）：
 *   - 骗子牌堆：K/Q/A 各 6 张 + 2 张小丑（万能，永远算真牌）共 20 张；
 *   - 桌面牌堆：K/Q/A 各 1 张，每轮翻一张定为「桌面点数」，翻尽重洗；
 *   - 每轮给每名存活玩家发 5 张手牌；
 *   - 轮到者盖着打出 1-3 张牌（声称全是桌面点数，可以撒谎），
 *     或质疑上一手「骗子！」——所出牌中只要有一张非（桌面点数或小丑）即吹牛成立；
 *   - 每轮输家（被抓的骗子 / 质疑失败者）翻自己专属左轮牌堆顶牌
 *     （1 致命 + 3 空包共 4 张，统一翻 1 张、翻掉不回填）：空包存活，致命出局；
 *   - 空手玩家跳过；只剩一人有手牌时该玩家必须质疑；
 *   - 新一轮先手 = 上一轮的输家（若已出局则顺位下一位存活者）；
 *   - 仅剩 1 人存活即获胜。
 *
 * 所有回合不变量都在这里维护；Discord 交互层只允许调用 apply() 并渲染返回的状态，
 * 不得直接改 hands/turnPlayerId/alive。
 */

const RANKS = Object.freeze(['K', 'Q', 'A']);
const JOKER = 'JOKER';

// 牌面展示（交互层渲染用；引擎不依赖）。K/Q/A 纯文字（emoji 会跟小丑抢戏），
// 仅小丑保留 🃏（它是唯一需要一眼认出的特殊牌）。
const CARD_LABELS = Object.freeze({
    K: 'K',
    Q: 'Q',
    A: 'A',
    JOKER: '🃏 小丑',
});

const HAND_SIZE = 5; // 每轮每人手牌数
const MAX_PLAY_CARDS = 3; // 每手最多盖出张数
const MIN_PLAY_CARDS = 1;

function buildLiarDeck() {
    const deck = [];
    for (const rank of RANKS) {
        for (let i = 0; i < 6; i++) deck.push(rank);
    }
    deck.push(JOKER, JOKER);
    return deck; // 20 张
}

function buildRevolverDeck() {
    return [true, false, false, false]; // 1 致命 + 3 空包（共 4，构造时洗牌）
}

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
        choice: arr => arr[Math.floor(Math.random() * arr.length)],
        shuffle: arr => {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            return arr;
        },
    };
}

// 默认值全字段齐全的稠密结果对象（交互层可放心读取任意字段）。
function defaultActionResult(action, actorId) {
    return {
        action, actorId,
        playedCards: [],          // 本手盖出的牌（play_cards）
        revealedCards: [],        // 质疑开牌翻出的牌（challenge）
        revealedBy: null,         // 被开牌的玩家（challenge 时的上一手出牌人）
        liar: null,               // 开牌结论：吹牛成立与否（challenge）
        challengeTableRank: null, // 开牌判定时的桌面点数（challenge；新一轮重置前留档）
        loserId: null,            // 本轮输家（challenge：骗子或错质疑者）
        lethal: null,             // 左轮翻牌是否致命（challenge）
        revolverFlips: [],        // 左轮逐张翻牌结果（true=致命；翻到致命即停）
        eliminatedId: null,       // 出局者（challenge 致命 / forfeit）
        newRound: false,          // 是否开了新一轮（challenge 后未终局）
        newTableRank: null,       // 新一轮桌面点数（newRound 时非空）
        firstPlayerId: null,      // 新一轮先���（newRound 时非空）
        gameEnded: false,
        winnerId: null,
    };
}

class LiarsBarState {
    constructor(playerIds, { rng = null } = {}) {
        const unique = [...new Set(playerIds)];
        assert(unique.length >= 2 && unique.length <= 4, '骗子酒馆需要 2-4 名玩家');
        this.rng = rng || defaultRng();
        this.players = unique; // 座位顺序 = 加入顺序，回合沿此循环
        this.phase = 'playing';
        this.winnerId = null;
        this.hands = {};
        this.revolverDecks = {}; // playerId -> 布尔数组（true=致命），游标即数组长度递减
        this.alive = new Set(unique);
        this.tableDeck = [];     // 桌面牌堆（剩余可翻的点数）
        this.tableRank = null;   // 本轮桌面点数
        this.roundNumber = 0;
        this.pileCount = 0;        // 本轮桌面已盖牌总张数（公开信息）
        this.playedThisRound = new Set(); // 本轮已盖过牌的玩家（每轮每人只能盖一手）
        this.lastPlay = null;    // { playerId, cards, count } 或 null（新一轮尚未出牌）
        this.turnPlayerId = null;
        this.turnToken = 0;
        for (const pid of unique) {
            this.hands[pid] = [];
            this.revolverDecks[pid] = this.rng.shuffle(buildRevolverDeck());
        }
        this.revolverPointers = {}; // pid -> 已翻张数（顶牌 = deck[pointer]，翻后 +1）
        for (const pid of unique) this.revolverPointers[pid] = 0;
        this._startRound(this.rng.choice(unique));
    }

    // ── 派生状态 ──

    get currentPlayerId() {
        return this.phase === 'ended' ? null : this.turnPlayerId;
    }

    // 是否强制质疑：桌上已有上一手，且本轮已无人能再盖牌（都盖过/空手/出局）
    // ——此时轮到谁谁开牌收尾。自己还能盖时永远不强制（盖或质疑自选）。
    get mustChallenge() {
        if (this.phase !== 'playing' || this.lastPlay == null) return false;
        return this._nextPlayerAbleToPlay(this.turnPlayerId) == null
            && this.canChallenge(this.turnPlayerId);
    }

    // 下一个还能盖牌的人（含起点自己）；全员不能盖返回 null。
    _nextPlayerAbleToPlay(afterPlayerId) {
        const seat = this.players.indexOf(afterPlayerId);
        for (let step = 0; step <= this.players.length; step++) {
            const pid = this.players[(seat + step) % this.players.length];
            if (step > 0 && pid === afterPlayerId) break;
            if (this.alive.has(pid)
                && !this.playedThisRound.has(pid)
                && this.hands[pid].length > 0) return pid;
        }
        return null;
    }

    handCards(playerId) {
        return this.hands[playerId] || [];
    }

    handText(playerId) {
        const cards = this.handCards(playerId);
        if (!cards.length) return '（空）';
        return cards.map(c => CARD_LABELS[c] || c).join('　');
    }

    // 某玩家左轮牌堆剩余致命/空包计数（公开信息：翻掉的牌是公开播报的）。
    revolverText(playerId) {
        const deck = this.revolverDecks[playerId] || [];
        const ptr = this.revolverPointers[playerId] || 0;
        const rest = deck.slice(ptr);
        const live = rest.filter(Boolean).length;
        return `🔫 致命 ${live} · 空包 ${rest.length - live}（剩 ${rest.length} 发）`;
    }

    // 某玩家左轮已翻次数（公开信息，用于面板显示压力值）。
    revolverFlips(playerId) {
        return this.revolverPointers[playerId] || 0;
    }

    // 某玩家下一次翻牌的致命概率（公开信息；已翻尽视为必死）。
    lethalOdds(playerId) {
        const deck = this.revolverDecks[playerId] || [];
        const ptr = this.revolverPointers[playerId] || 0;
        if (ptr >= deck.length) return 1;
        const rest = deck.slice(ptr);
        return rest.filter(Boolean).length / rest.length;
    }

    // 指定位置起顺位下一位「存活且有手牌」的玩家；找不到返回 null。
    _nextHolderWithCards(fromPlayerId) {
        const start = this.players.indexOf(fromPlayerId);
        assert(start !== -1, '玩家不在本局中。');
        for (let step = 1; step <= this.players.length; step++) {
            const pid = this.players[(start + step) % this.players.length];
            if (this.alive.has(pid) && this.hands[pid].length > 0) return pid;
        }
        return null;
    }

    // 出牌后交接回合：跳过空手玩家；只剩自己有牌 → 回到自己（mustChallenge 兜底质疑）。
    _advanceTurn(afterPlayerId) {
        // 每轮一手规则：回合交给下一个「还能盖牌」的人；全员不能盖 →
        // 交给非上一手出牌人的下一位存活者（质疑不需要手牌，TA 强制开牌收尾）。
        let next = this._nextPlayerAbleToPlay(this.players[(this.players.indexOf(afterPlayerId) + 1) % this.players.length]);
        if (next == null) {
            const seat = this.players.indexOf(afterPlayerId);
            next = afterPlayerId;
            if (this.lastPlay != null) {
                for (let step = 1; step <= this.players.length; step++) {
                    const pid = this.players[(seat + step) % this.players.length];
                    if (this.alive.has(pid) && pid !== this.lastPlay.playerId) {
                        next = pid;
                        break;
                    }
                }
            }
        }
        this.turnPlayerId = next;
    }

    // ── 轮次 ──

    _drawTableRank() {
        if (this.tableDeck.length === 0) {
            this.tableDeck = this.rng.shuffle([...RANKS]);
        }
        return this.tableDeck.pop();
    }

    _startRound(firstPlayerId) {
        this.roundNumber += 1;
        this.lastPlay = null;
        this.pileCount = 0;
        this.playedThisRound = new Set();
        const deck = this.rng.shuffle(buildLiarDeck());
        for (const pid of this.players) {
            this.hands[pid] = this.alive.has(pid) ? deck.splice(0, HAND_SIZE) : [];
        }
        this.tableRank = this._drawTableRank();
        // 先手若已出局，顺位下一位存活者。
        let first = firstPlayerId;
        if (!this.alive.has(first)) first = this._nextHolderWithCards(first) || first;
        this.turnPlayerId = first;
    }

    // ── 合法性判断 ──

    canPlayCards(userId, indexes) {
        if (this.phase !== 'playing' || userId !== this.turnPlayerId) return false;
        if (this.mustChallenge) return false;
        // 每轮每人只能盖一手牌：出过就得等开牌，逼玩家在一手里权衡张数。
        if (this.playedThisRound.has(userId)) return false;
        const hand = this.hands[userId];
        const uniq = [...new Set(indexes)];
        if (uniq.length < MIN_PLAY_CARDS || uniq.length > MAX_PLAY_CARDS) return false;
        return uniq.every(i => Number.isInteger(i) && i >= 0 && i < hand.length);
    }

    // 任意存活玩家（除上一手出牌人自己）都可抢质疑——先到先得，抢错自己翻左轮。
    // 当前行动者质疑走正常回合流；非行动者抢质疑同样合法（打断出牌）。
    canChallenge(userId) {
        if (this.phase !== 'playing' || !this.alive.has(userId)) return false;
        if (this.lastPlay == null) return false;
        return userId !== this.lastPlay.playerId;
    }

    // ── 入口 ──

    apply(action, actorId, { expectedToken = null, cardIndexes = null } = {}) {
        assert(this.phase !== 'ended', '这局已经结束了。');
        if (expectedToken != null) assert(expectedToken === this.turnToken, '这个按钮已经过期，请看最新面板。');
        if (action === 'challenge') {
            // 抢质疑：不要求是当前行动者（任意存活者可拍桌），但 token 必须是当前回合
            // （旧面板按钮随回合翻篇作废，防跨回合拍桌）。
            const result = this._challenge(actorId);
            this.turnToken += 1;
            return result;
        }
        assert(actorId === this.turnPlayerId, '现在还没轮到你。');
        assert(this.alive.has(actorId), '你已经出局了。');

        let result;
        if (action === 'play_cards') result = this._playCards(actorId, cardIndexes);
        else throw new InvalidAction('未知操作。');
        this.turnToken += 1;
        return result;
    }

    _playCards(actorId, indexes) {
        assert(this.canPlayCards(actorId, indexes), '不能这样出牌。');
        const uniq = [...new Set(indexes)].sort((a, b) => b - a); // 从大到小删，索引不漂移
        const cards = [];
        for (const i of uniq) {
            cards.push(this.hands[actorId][i]);
            this.hands[actorId].splice(i, 1);
        }
        this.lastPlay = { playerId: actorId, cards, count: cards.length };
        this.pileCount += cards.length;
        this.playedThisRound.add(actorId);
        this._advanceTurn(actorId);
        const result = defaultActionResult('play_cards', actorId);
        result.playedCards = cards;
        return result;
    }

    _challenge(actorId) {
        assert(this.canChallenge(actorId), '现在不能质疑。');
        const accused = this.lastPlay.playerId;
        const cards = this.lastPlay.cards;
        // 吹牛判定：非（桌面点数或小丑）的牌 = 假牌；一手里第 2 张及以后的小丑
        // 只算普通假牌（防双小丑免死：万能牌每手只认第一张）。
        let jokerSeen = false;
        const liar = cards.some(card => {
            if (card === JOKER) {
                if (!jokerSeen) { jokerSeen = true; return false; }
                return true; // 第二张小丑 = 假牌
            }
            return card !== this.tableRank;
        });
        const loserId = liar ? accused : actorId;

        const result = defaultActionResult('challenge', actorId);
        result.revealedCards = cards;
        result.revealedBy = accused;
        result.liar = liar;
        result.challengeTableRank = this.tableRank; // 新一轮会重置，先留档给交互层播报
        result.loserId = loserId;

        // 左轮翻牌：顶牌 = deck[pointer]，翻后指针后移（翻尽必死——第 4 发必致命）。
        // 统一翻 1 张（首翻致命率 1/4，翻掉不回填、越罚越危险）。
        const revolver = this.revolverDecks[loserId];
        const ptr = this.revolverPointers[loserId] || 0;
        const lethal = ptr < revolver.length ? revolver[ptr] : true;
        this.revolverPointers[loserId] = ptr + 1;
        result.lethal = lethal;
        result.revolverFlips = [lethal];

        if (lethal) {
            result.eliminatedId = loserId;
            this.alive.delete(loserId);
            this.hands[loserId] = [];
            if (this.alive.size <= 1) {
                this.phase = 'ended';
                this.winnerId = [...this.alive][0] || null;
                result.gameEnded = true;
                result.winnerId = this.winnerId;
                return result;
            }
        }

        // 开新一轮：先手 = 本轮输家（若已出局则由 _startRound 顺位）。
        this._startRound(loserId);
        result.newRound = true;
        result.newTableRank = this.tableRank;
        result.firstPlayerId = this.turnPlayerId;
        return result;
    }

    // 认输 / 成员失格：直接出局（左轮免翻），剩 1 人即终局。
    applyForfeit(actorId) {
        assert(this.phase !== 'ended', '这局已经结束了。');
        assert(this.players.includes(actorId) && this.alive.has(actorId), '该玩家不在本局或已出局。');
        const result = defaultActionResult('forfeit', actorId);
        result.loserId = actorId;
        result.eliminatedId = actorId;
        this.alive.delete(actorId);
        this.hands[actorId] = [];
        // 认输者若持本轮最后声明，声明随人作废：防止死后被"开尸"二次惩罚。
        if (this.lastPlay && this.lastPlay.playerId === actorId) {
            this.lastPlay = null;
        }
        if (this.alive.size <= 1) {
            this.phase = 'ended';
            this.winnerId = [...this.alive][0] || null;
            result.gameEnded = true;
            result.winnerId = this.winnerId;
            return result;
        }
        // 认输者正在行动回合时，回合交给顺位下一位；否则维持当前行动者。
        if (this.turnPlayerId === actorId) {
            const next = this._nextHolderWithCards(actorId);
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
            hands: this.hands,
            revolverDecks: this.revolverDecks,
            revolverPointers: this.revolverPointers,
            alive: [...this.alive],
            tableDeck: this.tableDeck,
            tableRank: this.tableRank,
            roundNumber: this.roundNumber,
            pileCount: this.pileCount,
            playedThisRound: [...this.playedThisRound],
            lastPlay: this.lastPlay,
            turnPlayerId: this.turnPlayerId,
            turnToken: this.turnToken,
        };
    }

    // 从快照重建状态。构造函数会先随机发一轮牌，这里全量覆盖成保存时的值，
    // 因此 rng 用 defaultRng 即可（续局不要求与中断前同随机序列）。
    static restore(data) {
        const s = new LiarsBarState(data.players, { rng: defaultRng() });
        s.phase = data.phase;
        s.winnerId = data.winnerId ?? null;
        s.hands = data.hands || {};
        s.revolverDecks = data.revolverDecks || {};
        s.revolverPointers = data.revolverPointers || {};
        s.alive = new Set(data.alive || data.players);
        s.tableDeck = data.tableDeck || [];
        s.tableRank = data.tableRank || null;
        s.roundNumber = data.roundNumber || 1;
        s.pileCount = data.pileCount || 0;
        s.playedThisRound = new Set(data.playedThisRound || []);
        s.lastPlay = data.lastPlay || null;
        s.turnPlayerId = data.turnPlayerId;
        s.turnToken = data.turnToken || 0;
        return s;
    }
}

module.exports = {
    LiarsBarState,
    InvalidAction,
    defaultRng,
    RANKS,
    JOKER,
    CARD_LABELS,
    HAND_SIZE,
    MAX_PLAY_CARDS,
    MIN_PLAY_CARDS,
};
