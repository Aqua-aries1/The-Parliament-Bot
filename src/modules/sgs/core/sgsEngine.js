/**
 * 三国杀纯状态机引擎（Node.js 原生移植版，零外部依赖，规范简体中文）。
 * 移植自 SGS 恶魔酒馆/恶魔轮盘重构版：
 * - 纯状态机设计，单一动作入口 + action_token 乐观锁；
 * - 完备装备特效：连弩、丈八、方天、青龙刀追击、麒麟弓拆马、白银狮子限伤回血；
 * - 锦囊 12 秒公共无懈可击抢断窗；
 * - 濒死求桃智能快跳 + 单次超时自动托管（Auto-Play）；
 * - 完整序列化/断点续传（serialize/restore）。
 */

class GameError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GameError';
    }
}

const Suit = {
    SPADE: '黑桃',
    HEART: '红桃',
    CLUB: '梅花',
    DIAMOND: '方块',
};

const SuitSymbol = {
    '黑桃': '♠',
    '红桃': '♥',
    '梅花': '♣',
    '方块': '♦',
};

const CardType = {
    BASIC: '基本牌',
    TRICK: '锦囊牌',
    DELAYED: '延时锦囊',
    EQUIPMENT: '装备牌',
};

const EquipmentSlot = {
    WEAPON: '武器',
    ARMOR: '防具',
    OFFENSIVE_MOUNT: '进攻坐骑',
    DEFENSIVE_MOUNT: '防御坐骑',
};

const Role = {
    LORD: '主公',
    LOYALIST: '忠臣',
    REBEL: '反贼',
    RENEGADE: '内奸',
};

const ROLE_TABLE = {
    3: [Role.LORD, Role.REBEL, Role.RENEGADE],
    4: [Role.LORD, Role.LOYALIST, Role.REBEL, Role.RENEGADE],
    5: [Role.LORD, Role.LOYALIST, Role.REBEL, Role.REBEL, Role.RENEGADE],
    6: [Role.LORD, Role.LOYALIST, Role.REBEL, Role.REBEL, Role.REBEL, Role.RENEGADE],
    7: [Role.LORD, Role.LOYALIST, Role.LOYALIST, Role.REBEL, Role.REBEL, Role.REBEL, Role.RENEGADE],
    8: [Role.LORD, Role.LOYALIST, Role.LOYALIST, Role.REBEL, Role.REBEL, Role.REBEL, Role.REBEL, Role.RENEGADE],
};

const SUPPORTED_TRICKS = new Set(['无中生有', '过河拆桥', '顺手牵羊', '决斗', '桃园结义', '五谷丰登', '南蛮入侵', '万箭齐发']);
const SLASH_LIKE_SKILLS = new Set(['武圣', '龙胆']);

class Card {
    constructor({ cardId, name, suit, rank, cardType, equipmentSlot = null, weaponRange = 1 }) {
        this.cardId = Number(cardId);
        this.name = name;
        this.suit = suit;
        this.rank = Number(rank);
        this.cardType = cardType;
        this.equipmentSlot = equipmentSlot;
        this.weaponRange = Number(weaponRange) || 1;
    }

    get color() {
        return (this.suit === Suit.HEART || this.suit === Suit.DIAMOND) ? '红色' : '黑色';
    }

    get rankText() {
        const map = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
        return map[this.rank] || String(this.rank);
    }

    get short() {
        return `${SuitSymbol[this.suit] || ''}${this.rankText}【${this.name}】`;
    }

    get detail() {
        const extra = this.equipmentSlot ? `／${this.equipmentSlot}` : '';
        return `${this.short}｜${this.color}｜${this.cardType}${extra}`;
    }

    toJSON() {
        return {
            card_id: this.cardId,
            name: this.name,
            suit: this.suit,
            rank: this.rank,
            card_type: this.cardType,
            equipment_slot: this.equipmentSlot,
            weapon_range: this.weaponRange,
        };
    }

    static fromJSON(data) {
        return new Card({
            cardId: data.card_id,
            name: data.name,
            suit: data.suit,
            rank: data.rank,
            cardType: data.card_type,
            equipmentSlot: data.equipment_slot,
            weaponRange: data.weapon_range || 1,
        });
    }
}

const SUIT_QUOTAS = {
    '杀': [...Array(13).fill(Suit.SPADE), ...Array(13).fill(Suit.CLUB), ...Array(9).fill(Suit.HEART), ...Array(9).fill(Suit.DIAMOND)],
    '闪': [...Array(7).fill(Suit.HEART), ...Array(8).fill(Suit.DIAMOND)],
    '桃': [...Array(6).fill(Suit.HEART), ...Array(2).fill(Suit.DIAMOND)],
    '无懈可击': [Suit.SPADE, Suit.CLUB, Suit.HEART, Suit.DIAMOND],
    '乐不思蜀': [Suit.SPADE, Suit.CLUB, Suit.HEART, Suit.DIAMOND],
};

function assignSuits(name, count, fallbackCycle) {
    const quota = SUIT_QUOTAS[name];
    if (quota && quota.length >= count) return quota.slice(0, count);
    if (quota) {
        const repeated = [];
        while (repeated.length < count) repeated.push(...quota);
        return repeated.slice(0, count);
    }
    return Array.from({ length: count }, (_, i) => fallbackCycle[i % fallbackCycle.length]);
}

function buildDeck(rng, batch = 0) {
    const basics = [
        ['杀', CardType.BASIC, 44],
        ['闪', CardType.BASIC, 15],
        ['桃', CardType.BASIC, 8],
    ];
    const tricks = [
        ['无中生有', 4], ['过河拆桥', 6], ['顺手牵羊', 5], ['决斗', 3],
        ['南蛮入侵', 3], ['万箭齐发', 1], ['桃园结义', 1], ['五谷丰登', 2],
        ['无懈可击', 4],
    ];
    const delayed = [['乐不思蜀', 4], ['兵粮寸断', 2], ['闪电', 2]];
    const weapons = [
        ['诸葛连弩', 1], ['青龙偃月刀', 3], ['丈八蛇矛', 3], ['方天画戟', 4], ['麒麟弓', 5],
    ];

    const cards = [];
    let cardId = 0;
    const cycle = [Suit.SPADE, Suit.HEART, Suit.CLUB, Suit.DIAMOND];

    for (const [name, cardType, count] of basics) {
        const ranks = [];
        while (ranks.length < count) {
            for (let r = 1; r <= 13 && ranks.length < count; r++) ranks.push(r);
        }
        shuffleArray(ranks, rng);
        const suits = assignSuits(name, count, cycle);
        for (let i = 0; i < count; i++) {
            cardId++;
            cards.push(new Card({ cardId: batch * 1000 + cardId, name, suit: suits[i], rank: ranks[i], cardType }));
        }
    }

    for (const [name, count] of tricks) {
        const suits = assignSuits(name, count, cycle);
        for (let i = 0; i < count; i++) {
            cardId++;
            cards.push(new Card({ cardId: batch * 1000 + cardId, name, suit: suits[i], rank: (i % 13) + 1, cardType: CardType.TRICK }));
        }
    }

    for (const [name, count] of delayed) {
        const suits = assignSuits(name, count, cycle);
        for (let i = 0; i < count; i++) {
            cardId++;
            cards.push(new Card({ cardId: batch * 1000 + cardId, name, suit: suits[i], rank: (i % 13) + 1, cardType: CardType.DELAYED }));
        }
    }

    for (const [name, weaponRange] of weapons) {
        cardId++;
        cards.push(new Card({
            cardId: batch * 1000 + cardId, name, suit: cycle[cardId % 4], rank: (cardId % 13) + 1,
            cardType: CardType.EQUIPMENT, equipmentSlot: EquipmentSlot.WEAPON, weaponRange,
        }));
    }

    for (let i = 0; i < 2; i++) {
        cardId++;
        cards.push(new Card({ cardId: batch * 1000 + cardId, name: '八卦阵', suit: cycle[cardId % 4], rank: (cardId % 13) + 1, cardType: CardType.EQUIPMENT, equipmentSlot: EquipmentSlot.ARMOR }));
        cardId++;
        cards.push(new Card({ cardId: batch * 1000 + cardId, name: '仁王盾', suit: cycle[cardId % 4], rank: (cardId % 13) + 1, cardType: CardType.EQUIPMENT, equipmentSlot: EquipmentSlot.ARMOR }));
    }

    cardId++;
    cards.push(new Card({ cardId: batch * 1000 + cardId, name: '白银狮子', suit: Suit.DIAMOND, rank: 1, cardType: CardType.EQUIPMENT, equipmentSlot: EquipmentSlot.ARMOR }));

    for (const name of ['赤兔', '大宛', '紫骍']) {
        cardId++;
        cards.push(new Card({ cardId: batch * 1000 + cardId, name, suit: cycle[cardId % 4], rank: (cardId % 13) + 1, cardType: CardType.EQUIPMENT, equipmentSlot: EquipmentSlot.OFFENSIVE_MOUNT }));
    }

    for (const name of ['的卢', '绝影', '爪黄飞电']) {
        cardId++;
        cards.push(new Card({ cardId: batch * 1000 + cardId, name, suit: cycle[cardId % 4], rank: (cardId % 13) + 1, cardType: CardType.EQUIPMENT, equipmentSlot: EquipmentSlot.DEFENSIVE_MOUNT }));
    }

    shuffleArray(cards, rng);
    return cards;
}

function emergencyDeck(rng, batch = 0) {
    const names = [
        ...Array(12).fill('杀'), ...Array(6).fill('闪'), ...Array(3).fill('桃'),
        ...Array(2).fill('无中生有'), ...Array(2).fill('无懈可击'),
    ];
    const cards = [];
    names.forEach((name, i) => {
        const quota = SUIT_QUOTAS[name] || [Suit.HEART, Suit.DIAMOND];
        cards.push(new Card({
            cardId: batch * 1000 + i + 1,
            name,
            suit: quota[i % quota.length],
            rank: (i % 13) + 1,
            cardType: ['杀', '闪', '桃'].includes(name) ? CardType.BASIC : CardType.TRICK,
        }));
    });
    shuffleArray(cards, rng);
    return cards;
}

function shuffleArray(array, rng) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor((rng ? rng() : Math.random()) * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

// ------------------------------------------------ 武将定义

const GENERAL_LIST = [
    { name: '刘备', faction: '蜀', maxHp: 4, skillName: '仁德', description: '出牌阶段限一次，可将一张手牌暗中交给一名其他角色并摸一张牌；牌名不公开。' },
    { name: '关羽', faction: '蜀', maxHp: 4, skillName: '武圣', description: '出牌阶段可将一张红色手牌当作【杀】使用；回应【杀】时也可打出红色手牌当作【杀】。' },
    { name: '张飞', faction: '蜀', maxHp: 4, skillName: '咆哮', description: '锁定技，你在出牌阶段使用【杀】无次数限制。' },
    { name: '诸葛亮', faction: '蜀', maxHp: 3, skillName: '观星', description: '你的摸牌阶段固定多摸一张牌。' },
    { name: '赵云', faction: '蜀', maxHp: 4, skillName: '龙胆', description: '你可以把【闪】当【杀】使用，也可以在回应时把【杀】当【闪】、把【闪】当【杀】打出。' },
    { name: '马超', faction: '蜀', maxHp: 4, skillName: '铁骑', description: '你使用【杀】时有一半概率发动铁骑；成功时该次攻击不能以【闪】响应。' },
    { name: '黄月英', faction: '蜀', maxHp: 3, skillName: '集智', description: '锁定技，你每次使用一张普通锦囊牌，立即摸一张牌。' },
    { name: '魏延', faction: '蜀', maxHp: 4, skillName: '狂骨', description: '锁定技，你以【杀】造成伤害后，若已受伤，回复 1 点体力。' },
    { name: '曹操', faction: '魏', maxHp: 4, skillName: '奸雄', description: '每次受到伤害后摸一张牌。' },
    { name: '司马懿', faction: '魏', maxHp: 3, skillName: '反馈', description: '受到有来源的伤害后，随机获取伤害来源的一张手牌；牌名不公开。' },
    { name: '夏侯惇', faction: '魏', maxHp: 4, skillName: '刚烈', description: '受到有来源的伤害后进行判定：若结果不为红桃，伤害来源须弃两张手牌，不足两张则受到 1 点伤害。' },
    { name: '郭嘉', faction: '魏', maxHp: 3, skillName: '遗计', description: '每次受到伤害后摸两张牌。' },
    { name: '甄姬', faction: '魏', maxHp: 3, skillName: '洛神', description: '自己的摸牌阶段有一半概率额外摸一张牌。' },
    { name: '许褚', faction: '魏', maxHp: 4, skillName: '裸衣', description: '摸牌阶段少摸一张；本回合你的【杀】伤害增加 1 点。' },
    { name: '张辽', faction: '魏', maxHp: 4, skillName: '突袭', description: '摸牌阶段少摸一张，并随机获取一名其他角色的一张手牌；牌名不公开。' },
    { name: '荀彧', faction: '魏', maxHp: 3, skillName: '节命', description: '受到伤害后，场上体力最低的存活角色摸一张牌。' },
    { name: '孙权', faction: '吴', maxHp: 4, skillName: '制衡', description: '出牌阶段限一次，你可以弃置任意张手牌，然后摸等量的牌。' },
    { name: '周瑜', faction: '吴', maxHp: 3, skillName: '英姿', description: '你的摸牌阶段固定多摸一张牌。' },
    { name: '甘宁', faction: '吴', maxHp: 4, skillName: '奇袭', description: '出牌阶段限一次，可将一张黑色手牌当作【过河拆桥】使用。' },
    { name: '吕蒙', faction: '吴', maxHp: 4, skillName: '克己', description: '若自己的回合没有使用【杀】，结束回合时摸一张牌。' },
    { name: '大乔', faction: '吴', maxHp: 3, skillName: '国色', description: '出牌阶段限一次，可将一张方块手牌当作【乐不思蜀】使用。' },
    { name: '陆逊', faction: '吴', maxHp: 3, skillName: '连营', description: '锁定技，每名角色的回合中，你第一次失去最后一张手牌时摸一张牌。' },
    { name: '孙尚香', faction: '吴', maxHp: 3, skillName: '枭姬', description: '每次回复体力后摸一张牌。' },
    { name: '黄盖', faction: '吴', maxHp: 4, skillName: '苦肉', description: '出牌阶段限一次，可失去 1 点体力并摸两张牌；不能以此阵亡。' },
    { name: '吕布', faction: '群', maxHp: 5, skillName: '无双', description: '锁定技，其他角色需要连续打出两张【闪】才能抵消你的【杀】。' },
    { name: '貂蝉', faction: '群', maxHp: 3, skillName: '离间', description: '出牌阶段限一次，弃置一张手牌，令两名其他角色进行决斗。' },
    { name: '华佗', faction: '群', maxHp: 3, skillName: '青囊', description: '出牌阶段限一次，弃一张手牌，令一名受伤角色回复 1 点体力。' },
    { name: '袁绍', faction: '群', maxHp: 4, skillName: '乱击', description: '出牌阶段限一次，可将两张花色相同的手牌当作【万箭齐发】使用。' },
    { name: '张角', faction: '群', maxHp: 3, skillName: '雷击', description: '你成功以【闪】避开【杀】后，攻击者受到 1 点伤害。' },
    { name: '董卓', faction: '群', maxHp: 6, skillName: '暴虐', description: '每次造成伤害后有一半概率摸一张牌。' },
    { name: '孟获', faction: '群', maxHp: 4, skillName: '祸首', description: '每名角色的回合中，你第一次受到的伤害会被免疫。' },
    { name: '祝融', faction: '群', maxHp: 4, skillName: '巨象', description: '锁定技，你每次以【杀】造成伤害后摸一张牌。' },
];

const GENERALS = Object.fromEntries(GENERAL_LIST.map(g => [g.name, g]));

const ACTIVE_SKILLS = {
    '仁德': { skillId: '仁德', general: '刘备', needsCard: true, cardCount: 1, targets: 1, targetFilter: 'other_alive', description: '交出一张手牌给一名其他角色，摸一张牌' },
    '武圣': { skillId: '武圣', general: '关羽', needsCard: true, cardCount: 1, cardFilter: c => c.color === '红色', targets: 1, needsRange: true, description: '红色手牌当【杀】使用' },
    '龙胆': { skillId: '龙胆', general: '赵云', needsCard: true, cardCount: 1, cardFilter: c => c.name === '闪', targets: 1, needsRange: true, description: '【闪】当【杀】使用' },
    '制衡': { skillId: '制衡', general: '孙权', needsCard: true, cardCount: -1, targets: 0, description: '弃置任意张手牌，摸等量的牌' },
    '奇袭': { skillId: '奇袭', general: '甘宁', needsCard: true, cardCount: 1, cardFilter: c => c.color === '黑色', targets: 1, description: '黑色手牌当【过河拆桥】使用' },
    '国色': { skillId: '国色', general: '大乔', needsCard: true, cardCount: 1, cardFilter: c => c.suit === Suit.DIAMOND, targets: 1, description: '方块手牌当【乐不思蜀】使用' },
    '青囊': { skillId: '青囊', general: '华佗', needsCard: true, cardCount: 1, targets: 1, targetFilter: 'wounded', description: '弃一张手牌，令一名受伤角色回复 1 点体力' },
    '苦肉': { skillId: '苦肉', general: '黄盖', needsCard: false, cardCount: 0, targets: 0, description: '失去 1 点体力，摸两张牌' },
    '离间': { skillId: '离间', general: '貂蝉', needsCard: true, cardCount: 1, targets: 2, targetFilter: 'other_alive', description: '弃一张手牌，令两名角色进行决斗' },
    '乱击': { skillId: '乱击', general: '袁绍', needsCard: true, cardCount: 2, sameSuit: true, targets: 0, description: '两张同花色手牌当【万箭齐发】使用' },
};

const ACTIVE_SKILLS_BY_GENERAL = {};
for (const spec of Object.values(ACTIVE_SKILLS)) {
    if (!ACTIVE_SKILLS_BY_GENERAL[spec.general]) ACTIVE_SKILLS_BY_GENERAL[spec.general] = [];
    ACTIVE_SKILLS_BY_GENERAL[spec.general].push(spec);
}

// ------------------------------------------------ 玩家与等待状态

class Player {
    constructor({ userId, name, role = null, general = null, hp = 4, maxHp = 4,
                 hand = [], equipment = {}, delayed = [], alive = true,
                 slashUsed = false, skillUsed = false, peachSkillUsed = false,
                 emptyHandTriggered = false, damagePrevented = false,
                 skipPlay = false, skipDraw = false, damageBoost = false,
                 autoPlay = false }) {
        this.userId = String(userId);
        this.name = name;
        this.role = role;
        this.general = general;
        this.hp = Number(hp);
        this.maxHp = Number(maxHp);
        this.hand = hand;
        this.equipment = equipment; // slot -> Card
        this.delayed = delayed;     // Card[]
        this.alive = Boolean(alive);
        this.slashUsed = Boolean(slashUsed);
        this.skillUsed = Boolean(skillUsed);
        this.peachSkillUsed = Boolean(peachSkillUsed);
        this.emptyHandTriggered = Boolean(emptyHandTriggered);
        this.damagePrevented = Boolean(damagePrevented);
        this.skipPlay = Boolean(skipPlay);
        this.skipDraw = Boolean(skipDraw);
        this.damageBoost = Boolean(damageBoost);
        this.autoPlay = Boolean(autoPlay);
    }

    toJSON() {
        const equipObj = {};
        for (const [k, v] of Object.entries(this.equipment)) {
            equipObj[k] = v.toJSON();
        }
        return {
            user_id: this.userId,
            name: this.name,
            role: this.role,
            general: this.general,
            hp: this.hp,
            max_hp: this.maxHp,
            hand: this.hand.map(c => c.toJSON()),
            equipment: equipObj,
            delayed: this.delayed.map(c => c.toJSON()),
            alive: this.alive,
            slash_used: this.slashUsed,
            skill_used: this.skillUsed,
            peach_skill_used: this.peachSkillUsed,
            empty_hand_triggered: this.emptyHandTriggered,
            damage_prevented: this.damagePrevented,
            skip_play: this.skipPlay,
            skip_draw: this.skipDraw,
            damage_boost: this.damageBoost,
            auto_play: this.autoPlay,
        };
    }

    static fromJSON(data) {
        const equipObj = {};
        for (const [k, v] of Object.entries(data.equipment || {})) {
            equipObj[k] = Card.fromJSON(v);
        }
        return new Player({
            userId: data.user_id,
            name: data.name,
            role: data.role,
            general: data.general,
            hp: data.hp,
            maxHp: data.max_hp,
            hand: (data.hand || []).map(c => Card.fromJSON(c)),
            equipment: equipObj,
            delayed: (data.delayed || []).map(c => Card.fromJSON(c)),
            alive: data.alive,
            slashUsed: data.slash_used,
            skillUsed: data.skill_used,
            peachSkillUsed: data.peach_skill_used,
            emptyHandTriggered: data.empty_hand_triggered,
            damagePrevented: data.damage_prevented,
            skipPlay: data.skip_play,
            skipDraw: data.skip_draw,
            damageBoost: data.damage_boost,
            autoPlay: data.auto_play,
        });
    }
}

class Pending {
    constructor({ kind, deciderId, initiatorId = null, queue = [], data = {} }) {
        this.kind = kind;
        this.deciderId = String(deciderId);
        this.initiatorId = initiatorId ? String(initiatorId) : null;
        this.queue = queue.map(String);
        this.data = { ...data };
    }

    toJSON() {
        return {
            kind: this.kind,
            decider_id: this.deciderId,
            initiator_id: this.initiatorId,
            queue: [...this.queue],
            data: { ...this.data },
        };
    }

    static fromJSON(data) {
        return new Pending({
            kind: data.kind,
            deciderId: data.decider_id,
            initiatorId: data.initiator_id,
            queue: data.queue || [],
            data: data.data || {},
        });
    }
}

class ActionResult {
    constructor({ events = [], token = 0, finished = false, winner = null, pendingKind = null, pendingDecider = null, awaitingPlay = false }) {
        this.events = events;
        this.token = token;
        this.finished = finished;
        this.winner = winner;
        this.pendingKind = pendingKind;
        this.pendingDecider = pendingDecider;
        this.awaitingPlay = awaitingPlay;
    }

    static build(game, events) {
        const top = game.pendingTop;
        return new ActionResult({
            events,
            token: game.actionToken,
            finished: game.finished,
            winner: game.winner,
            pendingKind: top ? top.kind : null,
            pendingDecider: top ? top.deciderId : null,
            awaitingPlay: Boolean(game.started && !game.finished && !top),
        });
    }
}

// ------------------------------------------------ 技能 Triggers 注册表

const TRIGGERS = {
    pre_damage: {
        '孟获': (game, ctx) => {
            if (!ctx.target.damagePrevented) {
                ctx.target.damagePrevented = true;
                ctx.prevented = true;
                ctx.events.push({ type: 'skill', player_id: ctx.target.userId, skill_name: '祸首', note: '防止本次伤害' });
            }
        },
    },
    draw_phase: {
        '诸葛亮': (game, ctx) => {
            ctx.count += 1;
            ctx.events.push({ type: 'skill', player_id: ctx.player.userId, skill_name: '观星', note: '摸牌阶段多摸一张牌' });
        },
        '周瑜': (game, ctx) => {
            ctx.count += 1;
            ctx.events.push({ type: 'skill', player_id: ctx.player.userId, skill_name: '英姿', note: '摸牌阶段多摸一张牌' });
        },
        '甄姬': (game, ctx) => {
            if (game._random() < 0.5) {
                ctx.count += 1;
                ctx.events.push({ type: 'skill', player_id: ctx.player.userId, skill_name: '洛神', note: '额外摸一张牌' });
            }
        },
        '许褚': (game, ctx) => {
            if (ctx.count > 0) {
                ctx.count -= 1;
                ctx.player.damageBoost = true;
                ctx.events.push({ type: 'skill', player_id: ctx.player.userId, skill_name: '裸衣', note: '本回合【杀】的伤害增加 1 点' });
            }
        },
        '张辽': (game, ctx) => {
            const player = ctx.player;
            if (ctx.count <= 0) return;
            ctx.count -= 1;
            const victims = game.players.filter(p => p.alive && p !== player && p.hand.length > 0);
            if (victims.length > 0) {
                const victim = game._choice(victims);
                const card = game._choice(victim.hand);
                game.removeHandCard(victim, card, ctx.events);
                player.hand.push(card);
                ctx.events.push({ type: 'steal', from_id: victim.userId, to_id: player.userId, zone_text: '一张手牌（牌名保密）', reason: '突袭' });
            }
        },
    },
    attack_profile: {
        '许褚': (game, ctx) => {
            if (ctx.attacker.damageBoost) ctx.profile.damage = 2;
        },
        '马超': (game, ctx) => {
            if (game._random() < 0.5) {
                ctx.profile.pierce = true;
                ctx.events.push({ type: 'skill', player_id: ctx.attacker.userId, skill_name: '铁骑', note: '本次攻击不能以【闪】响应' });
            }
        },
        '吕布': (game, ctx) => {
            ctx.profile.dodges = 2;
        },
    },
    response_options: {
        '赵云': (game, ctx) => {
            const needed = ctx.needed;
            const alternate = (needed === '杀') ? '闪' : '杀';
            for (const c of ctx.player.hand) {
                if (c.name === alternate) ctx.options.push([c, '（【龙胆】转换）']);
            }
        },
        '关羽': (game, ctx) => {
            if (ctx.needed !== '杀') return;
            for (const c of ctx.player.hand) {
                if (c.color === '红色') ctx.options.push([c, '（【武圣】转换）']);
            }
        },
    },
    on_dodge_complete: {
        '张角': (game, ctx) => {
            ctx.events.push({ type: 'skill', player_id: ctx.dodger.userId, skill_name: '雷击', note: `令 ${ctx.attacker.name} 受到 1 点伤害` });
            game.dealDamage(ctx.attacker, 1, ctx.dodger, '雷击', ctx.events);
        },
    },
    post_damage_target: {
        '曹操': (game, ctx) => {
            game.drawCards(ctx.target, 1);
            ctx.events.push({ type: 'skill', player_id: ctx.target.userId, skill_name: '奸雄', note: '摸一张牌' });
        },
        '郭嘉': (game, ctx) => {
            game.drawCards(ctx.target, 2);
            ctx.events.push({ type: 'skill', player_id: ctx.target.userId, skill_name: '遗计', note: '摸两张牌' });
        },
        '司马懿': (game, ctx) => {
            if (!ctx.source || ctx.source.hand.length === 0) return;
            const card = game._choice(ctx.source.hand);
            game.removeHandCard(ctx.source, card, ctx.events);
            ctx.target.hand.push(card);
            ctx.events.push({ type: 'steal', from_id: ctx.source.userId, to_id: ctx.target.userId, zone_text: '一张手牌（牌名保密）', reason: '反馈' });
        },
        '荀彧': (game, ctx) => {
            const living = game.players.filter(p => p.alive);
            if (!living.length) return;
            let lowest = living[0];
            for (const p of living) {
                if (p.hp < lowest.hp) lowest = p;
            }
            game.drawCards(lowest, 1);
            ctx.events.push({ type: 'skill', player_id: ctx.target.userId, skill_name: '节命', note: `令 ${lowest.name} 摸一张牌` });
        },
        '夏侯惇': (game, ctx) => {
            if (!ctx.source || !ctx.source.alive) return;
            const judged = game.judge(ctx.target, '刚烈', ctx.events);
            if (judged.suit !== Suit.HEART) {
                ctx.events.push({ type: 'skill', player_id: ctx.target.userId, skill_name: '刚烈', note: `判定为 ${judged.short}（非红桃）` });
                if (ctx.source.hand.length >= 2) {
                    const discarded = game._sample(ctx.source.hand, 2);
                    for (const c of discarded) {
                        game.removeHandCard(ctx.source, c, ctx.events);
                        game.discard.push(c);
                    }
                    ctx.events.push({ type: 'discard', player_id: ctx.source.userId, count: 2, auto: true });
                    ctx.events.push({ type: 'note', text: `${ctx.source.name} 弃置了 2 张手牌以抵御刚烈。` });
                } else {
                    ctx.events.push({ type: 'note', text: `${ctx.source.name} 手牌不足两张，受到 1 点伤害。` });
                    game.dealDamage(ctx.source, 1, ctx.target, '刚烈', ctx.events);
                }
            } else {
                ctx.events.push({ type: 'note', text: `${ctx.target.name} 的刚烈判定为红桃，未生效。` });
            }
        },
    },
    post_damage_source: {
        '魏延': (game, ctx) => {
            if (!ctx.source || ctx.via !== '杀' || !ctx.source.alive || ctx.source.hp >= ctx.source.maxHp) return;
            ctx.events.push({ type: 'skill', player_id: ctx.source.userId, skill_name: '狂骨', note: '回复 1 点体力' });
            game.healPlayer(ctx.source, 1, ctx.events);
        },
        '祝融': (game, ctx) => {
            if (!ctx.source || ctx.via !== '杀' || !ctx.source.alive) return;
            game.drawCards(ctx.source, 1);
            ctx.events.push({ type: 'skill', player_id: ctx.source.userId, skill_name: '巨象', note: '摸一张牌' });
        },
        '董卓': (game, ctx) => {
            if (!ctx.source || !ctx.source.alive || game._random() >= 0.5) return;
            game.drawCards(ctx.source, 1);
            ctx.events.push({ type: 'skill', player_id: ctx.source.userId, skill_name: '暴虐', note: '摸一张牌' });
        },
    },
    on_heal: {
        '孙尚香': (game, ctx) => {
            game.drawCards(ctx.player, 1);
            ctx.events.push({ type: 'skill', player_id: ctx.player.userId, skill_name: '枭姬', note: '摸一张牌' });
        },
    },
    on_trick: {
        '黄月英': (game, ctx) => {
            game.drawCards(ctx.player, 1, '集智');
            ctx.events.push({ type: 'skill', player_id: ctx.player.userId, skill_name: '集智', note: '摸一张牌' });
        },
    },
    on_hand_empty: {
        '陆逊': (game, ctx) => {
            if (ctx.player.hand.length === 0 && !ctx.player.emptyHandTriggered) {
                ctx.player.emptyHandTriggered = true;
                game.drawCards(ctx.player, 1);
                ctx.events.push({ type: 'skill', player_id: ctx.player.userId, skill_name: '连营', note: '摸一张牌' });
            }
        },
    },
    on_turn_end: {
        '吕蒙': (game, ctx) => {
            if (!ctx.player.slashUsed) {
                game.drawCards(ctx.player, 1);
                ctx.events.push({ type: 'skill', player_id: ctx.player.userId, skill_name: '克己', note: '摸一张牌' });
            }
        },
    },
};

const ACTIVE_EFFECTS = {
    '仁德': (game, player, spec, cards, targets, events) => {
        const [card, receiver] = [cards[0], targets[0]];
        game.removeHandCard(player, card);
        receiver.hand.push(card);
        game.drawCards(player, 1);
        player.skillUsed = true;
        events.push({ type: 'skill', player_id: player.userId, skill_name: '仁德', note: `暗中交给 ${receiver.name} 一张手牌（牌名保密）` });
    },
    '武圣': (game, player, spec, cards, targets, events) => {
        game.attackWithCard(player, cards[0], targets[0], events, '（【武圣】当【杀】）');
    },
    '龙胆': (game, player, spec, cards, targets, events) => {
        game.attackWithCard(player, cards[0], targets[0], events, '（【龙胆】当【杀】）');
    },
    '制衡': (game, player, spec, cards, targets, events) => {
        const count = cards.length;
        for (const card of cards) {
            game.removeHandCard(player, card);
            game.discard.push(card);
        }
        game.drawCards(player, count, '制衡');
        player.skillUsed = true;
        events.push({ type: 'skill', player_id: player.userId, skill_name: '制衡', note: `弃置 ${count} 张手牌并摸等量牌` });
    },
    '奇袭': (game, player, spec, cards, targets, events) => {
        const target = targets[0];
        if (!target.hand.length && !Object.keys(target.equipment).length && !target.delayed.length) {
            throw new GameError('目标没有任何可弃置的牌。');
        }
        game.removeHandCard(player, cards[0]);
        game.discard.push(cards[0]);
        player.skillUsed = true;
        game.pendingStack.push(new Pending({
            kind: 'zone', deciderId: player.userId,
            data: { target_id: target.userId, mode: 'discard', reason: '奇袭' },
        }));
        events.push({ type: 'skill', player_id: player.userId, skill_name: '奇袭' });
        events.push({ type: 'pending', kind: 'zone', decider_id: player.userId });
    },
    '国色': (game, player, spec, cards, targets, events) => {
        const target = targets[0];
        if (target.delayed.some(d => d.name === '乐不思蜀')) throw new GameError('目标已有【乐不思蜀】。');
        const converted = game.convertCard(cards[0], '乐不思蜀', CardType.DELAYED);
        game.removeHandCard(player, cards[0]);
        game.discard.push(cards[0]); // 转化生成的是新牌对象，原牌必须入弃牌堆（否则全场总牌数凭空减员）
        target.delayed.push(converted);
        player.skillUsed = true;
        events.push({ type: 'skill', player_id: player.userId, skill_name: '国色', note: `将 ${cards[0].short} 当【乐不思蜀】置于 ${target.name} 的判定区` });
    },
    '青囊': (game, player, spec, cards, targets, events) => {
        game.removeHandCard(player, cards[0]);
        game.discard.push(cards[0]);
        game.healPlayer(targets[0], 1, events, '青囊');
        player.skillUsed = true;
        events.push({ type: 'skill', player_id: player.userId, skill_name: '青囊', note: `令 ${targets[0].name} 回复 1 点体力` });
    },
    '苦肉': (game, player, spec, cards, targets, events) => {
        if (player.hp <= 1) throw new GameError('体力不足，不能发动【苦肉】。');
        player.hp -= 1;
        events.push({ type: 'lose_hp', target_id: player.userId, amount: 1, hp: player.hp, max_hp: player.maxHp, reason: '苦肉' });
        game.drawCards(player, 2);
        player.skillUsed = true;
        events.push({ type: 'skill', player_id: player.userId, skill_name: '苦肉' });
    },
    '离间': (game, player, spec, cards, targets, events) => {
        const [first, second] = targets;
        game.removeHandCard(player, cards[0]);
        game.discard.push(cards[0]);
        player.skillUsed = true;
        events.push({ type: 'skill', player_id: player.userId, skill_name: '离间', note: `弃一张手牌，令 ${first.name} 与 ${second.name} 进行【决斗】` });
        game.pendingStack.push(new Pending({
            kind: 'duel', deciderId: second.userId, initiatorId: first.userId,
            data: { other_id: first.userId },
        }));
        events.push({ type: 'pending', kind: 'duel', decider_id: second.userId });
    },
    '乱击': (game, player, spec, cards, targets, events) => {
        for (const c of cards) {
            game.removeHandCard(player, c);
            game.discard.push(c);
        }
        player.skillUsed = true;
        events.push({ type: 'skill', player_id: player.userId, skill_name: '乱击', note: `以 ${cards.map(c => c.short).join('、')} 当【万箭齐发】` });
        game.launchAoe(player, '闪', '万箭齐发', events);
    },
};

// ------------------------------------------------ Game 引擎本体

class Game {
    constructor({ guildId, channelId, ownerId, ownerName, seed = null, rng = null }) {
        this.guildId = String(guildId);
        this.channelId = String(channelId);
        this.ownerId = String(ownerId);
        this.players = [new Player({ userId: ownerId, name: ownerName })];
        this.started = false;
        this.finished = false;
        this.winner = null;
        this.turnIndex = 0;
        this.deck = [];
        this.discard = [];
        this.pendingStack = [];
        this.actionToken = 0;
        this.deckBatch = 1;
        this.idCounter = 1_000_000_000;
        this.beginInterrupted = false;
        this._ev = [];
        this.rng = rng || (seed ? createSeededRng(seed) : Math.random);
    }

    _random() {
        return this.rng();
    }

    _choice(arr) {
        if (!arr.length) return null;
        const idx = Math.floor(this._random() * arr.length);
        return arr[idx];
    }

    _sample(arr, n) {
        const copy = [...arr];
        shuffleArray(copy, this.rng);
        return copy.slice(0, n);
    }

    get current() {
        return this.players[this.turnIndex];
    }

    get pendingTop() {
        return this.pendingStack.length ? this.pendingStack[this.pendingStack.length - 1] : null;
    }

    player(userId) {
        const uid = String(userId);
        const p = this.players.find(x => x.userId === uid);
        if (!p) throw new GameError('你不在这个房间里。');
        return p;
    }

    _playerMaybe(userId) {
        if (userId === null || userId === undefined) return null;
        const uid = String(userId);
        return this.players.find(x => x.userId === uid) || null;
    }

    _aliveOthers(player) {
        return this.players.filter(p => p.alive && p !== player);
    }

    _seatOrderFrom(start, excludeSelf = true) {
        const base = this.players.filter(p => p.alive).map(p => p.userId);
        const idx = base.indexOf(start.userId);
        if (idx === -1) return [];
        let ordered = [...base.slice(idx), ...base.slice(0, idx)];
        if (excludeSelf && ordered.length && ordered[0] === start.userId) {
            ordered = ordered.slice(1);
        }
        return ordered;
    }

    setAutoPlay(userId, auto) {
        const p = this.player(userId);
        p.autoPlay = Boolean(auto);
    }

    // ------------------------------------------------ 序列化

    serialize() {
        return {
            guild_id: this.guildId,
            channel_id: this.channelId,
            owner_id: this.ownerId,
            started: this.started,
            finished: this.finished,
            winner: this.winner,
            turn_index: this.turnIndex,
            action_token: this.actionToken,
            deck_batch: this.deckBatch,
            id_counter: this.idCounter,
            begin_interrupted: this.beginInterrupted,
            players: this.players.map(p => p.toJSON()),
            deck: this.deck.map(c => c.toJSON()),
            discard: this.discard.map(c => c.toJSON()),
            pending_stack: this.pendingStack.map(p => p.toJSON()),
        };
    }

    static restore(data, rng = null) {
        const game = new Game({
            guildId: data.guild_id,
            channelId: data.channel_id,
            ownerId: data.owner_id,
            ownerName: '',
            rng,
        });
        game.started = data.started;
        game.finished = data.finished;
        game.winner = data.winner || null;
        game.turnIndex = data.turn_index;
        game.actionToken = data.action_token || 0;
        game.deckBatch = data.deck_batch || 1;
        game.idCounter = data.id_counter || 1_000_000_000;
        game.beginInterrupted = data.begin_interrupted || false;
        game.players = (data.players || []).map(p => Player.fromJSON(p));
        game.deck = (data.deck || []).map(c => Card.fromJSON(c));
        game.discard = (data.discard || []).map(c => Card.fromJSON(c));
        game.pendingStack = (data.pending_stack || []).map(p => Pending.fromJSON(p));
        return game;
    }

    // ------------------------------------------------ 房间管理

    join(userId, name) {
        const uid = String(userId);
        if (this.started) throw new GameError('游戏已经开始，无法加入。');
        if (this.players.some(p => p.userId === uid)) throw new GameError('你已经在这个房间里了。');
        if (this.players.length >= 8) throw new GameError('房间已满（最多 8 人）。');
        this.players.push(new Player({ userId: uid, name }));
        return `${name} 加入了游戏（${this.players.length}/8）。`;
    }

    leave(userId) {
        const uid = String(userId);
        if (this.started) throw new GameError('游戏进行中不能离开。');
        if (uid === this.ownerId) throw new GameError('房主不能离开；请解散房间。');
        const p = this.player(uid);
        this.players = this.players.filter(x => x !== p);
        return `${p.name} 已离开房间。`;
    }

    chooseGeneral(userId, name) {
        if (this.started) throw new GameError('游戏开始后不能更换武将。');
        if (!GENERALS[name]) throw new GameError('找不到这名武将。');
        const p = this.player(userId);
        if (this.players.some(x => x !== p && x.general === name)) {
            throw new GameError('这名武将已被其他玩家选走。');
        }
        p.general = name;
        return `${p.name} 选择了【${name}】。`;
    }

    start(userId) {
        if (String(userId) !== this.ownerId) throw new GameError('只有房主可以开始。');
        if (this.started) throw new GameError('游戏已经开始。');
        const count = this.players.length;
        if (!ROLE_TABLE[count]) throw new GameError('需要 3～8 名玩家。');

        this._ev = [];
        const roles = [...ROLE_TABLE[count]];
        const lordIndex = Math.floor(this._random() * count);
        const otherRoles = roles.slice(1);
        shuffleArray(otherRoles, this.rng);

        const used = new Set(this.players.map(p => p.general).filter(Boolean));
        const available = GENERAL_LIST.map(g => g.name).filter(n => !used.has(n));
        shuffleArray(available, this.rng);

        let roleIdx = 0;
        for (let i = 0; i < this.players.length; i++) {
            const p = this.players[i];
            p.role = (i === lordIndex) ? Role.LORD : otherRoles[roleIdx++];
            if (!p.general) p.general = available.pop();
            const baseHp = GENERALS[p.general].maxHp;
            p.maxHp = baseHp + (p.role === Role.LORD ? 1 : 0);
            p.hp = p.maxHp;
        }

        this.deck = buildDeck(this.rng, this.deckBatch);
        for (const p of this.players) {
            this.drawCards(p, 4);
        }
        this.turnIndex = lordIndex;
        this.started = true;
        this._beginTurn();
        return this._result();
    }

    // ------------------------------------------------ 回合内出牌动作

    playCard(userId, cardIndex = null, targetId = null, expectedToken = null, { cardIndexes = null, targetIds = null } = {}) {
        const player = this._ensureTurn(userId, expectedToken);
        const events = this._ev;

        // 丈八蛇矛：两张手牌当【杀】
        if (cardIndexes && cardIndexes.length === 2) {
            const weapon = player.equipment[EquipmentSlot.WEAPON];
            if (!weapon || weapon.name !== '丈八蛇矛') {
                throw new GameError('只有装备【丈八蛇矛】才能将两张手牌当【杀】使用。');
            }
            const c1 = this._handCard(player, cardIndexes[0]);
            const c2 = this._handCard(player, cardIndexes[1]);
            if (c1 === c2) throw new GameError('不能指定相同的两张手牌。');
            const tid = targetId || (targetIds ? targetIds[0] : null);
            const target = this._validOther(player, tid);

            const unlimitedZb = player.general === '张飞' || (weapon && weapon.name === '诸葛连弩');
            if (player.slashUsed && !unlimitedZb) {
                throw new GameError('每回合只能使用一张【杀】；装备【诸葛连弩】可取消限制。');
            }
            // 校验全部通过后才动牌：范围不符时不能吞掉玩家的两张手牌。
            if (this.distance(player, target) > this.attackRange(player)) {
                throw new GameError(`目标距离为 ${this.distance(player, target)}，超出目前攻击范围 ${this.attackRange(player)}。`);
            }

            this.removeHandCard(player, c1);
            this.removeHandCard(player, c2);
            this.discard.push(c1, c2);

            player.slashUsed = true;
            const fakeSlash = new Card({ cardId: this._nextCardId(), name: '杀', suit: Suit.SPADE, rank: 1, cardType: CardType.BASIC });
            this._launchSingleAttack(player, fakeSlash, target, events, '（【丈八蛇矛】双牌转化）');
            this.actionToken += 1;
            return this._result();
        }

        if (cardIndex === null || cardIndex === undefined) throw new GameError('请指定要使用的卡牌。');
        const card = this._handCard(player, cardIndex);

        if (card.name === '杀') {
            const weapon = player.equipment[EquipmentSlot.WEAPON];
            const tids = targetIds || (targetId ? [targetId] : []);
            if (tids.length > 1) {
                if (!(weapon && weapon.name === '方天画戟' && player.hand.length === 1)) {
                    throw new GameError('只有装备【方天画戟】且使用最后一张手牌【杀】时，才可指定多名目标。');
                }
                if (tids.length > 3) throw new GameError('【方天画戟】最多指定 3 名目标。');
                const targets = tids.map(tid => this._validOther(player, tid));
                if (new Set(targets.map(t => t.userId)).size !== targets.length) {
                    throw new GameError('多名目标不能重复。');
                }
                const unlimitedFt = player.general === '张飞' || (weapon && weapon.name === '诸葛连弩');
                if (player.slashUsed && !unlimitedFt) {
                    throw new GameError('每回合只能使用一张【杀】；装备【诸葛连弩】可取消限制。');
                }
                // 先校验全部目标的攻击范围再动牌，避免中途失败留下半改状态。
                for (const t of targets) {
                    if (this.distance(player, t) > this.attackRange(player)) {
                        throw new GameError(`目标距离为 ${this.distance(player, t)}，超出目前攻击范围 ${this.attackRange(player)}。`);
                    }
                }
                this.removeHandCard(player, card);
                this.discard.push(card);
                player.slashUsed = true;
                for (const t of targets) {
                    this._launchSingleAttack(player, card, t, events, '（【方天画戟】多目标）');
                }
            } else {
                const tid = tids.length ? tids[0] : null;
                this.attackWithCard(player, card, this._validOther(player, tid), events);
            }
        } else if (card.name === '桃') {
            this._playPeach(player, card, events);
        } else if (card.name === '闪') {
            throw new GameError('【闪】用于回应攻击，请通过回应面板打出。');
        } else if (card.cardType === CardType.EQUIPMENT) {
            this._equipCard(player, card, events);
        } else if (card.cardType === CardType.DELAYED) {
            this._placeDelayed(player, card, targetId, events);
        } else {
            this._playTrick(player, card, targetId, events);
        }

        this.actionToken += 1;
        return this._result();
    }

    activeSkill(userId, skillId, cardIndexes = null, targetIds = null, expectedToken = null) {
        const player = this._ensureTurn(userId, expectedToken);
        const spec = ACTIVE_SKILLS[skillId];
        if (!spec || spec.general !== player.general) throw new GameError('这名武将没有这个主动技能。');
        if (player.skillUsed && !SLASH_LIKE_SKILLS.has(skillId)) throw new GameError('本回合已使用过主动技能。');

        const cIdxs = cardIndexes || [];
        const tIds = targetIds || [];
        const events = this._ev;
        const cards = [];

        if (spec.needsCard) {
            if (spec.cardCount === -1) {
                if (!cIdxs.length) throw new GameError(`【${skillId}】请至少指定一张手牌。`);
            } else if (cIdxs.length !== spec.cardCount) {
                throw new GameError(`【${skillId}】需要指定 ${spec.cardCount} 张手牌。`);
            }
            for (const i of cIdxs) {
                cards.push(this._handCard(player, i));
            }
            if (new Set(cards.map(c => c.cardId)).size !== cards.length) {
                throw new GameError('不能重复指定同一张手牌。');
            }
            if (spec.sameSuit && cards.length === 2 && cards[0].suit !== cards[1].suit) {
                throw new GameError(`【${skillId}】需要两张花色相同的手牌。`);
            }
            if (spec.cardFilter && !cards.every(c => spec.cardFilter(c))) {
                throw new GameError(`【${skillId}】的牌不符合条件。`);
            }
        }

        const targets = [];
        for (const t of tIds) {
            const found = this._playerMaybe(t);
            if (!found) throw new GameError('目标必须是本局玩家。');
            targets.push(found);
        }
        if (spec.targets !== targets.length) throw new GameError(`【${skillId}】需要指定 ${spec.targets} 名目标。`);

        for (const t of targets) {
            if (spec.targetFilter === 'other_alive' && (!t.alive || t === player)) {
                throw new GameError('请指定一名其他存活角色。');
            }
            if (spec.targetFilter === 'wounded' && (!t.alive || t === player || t.hp >= t.maxHp)) {
                throw new GameError('请指定一名受伤的存活角色。');
            }
        }
        if (spec.targets > 1 && new Set(targets.map(t => t.userId)).size !== spec.targets) {
            throw new GameError('多名目标不能重复。');
        }
        if (spec.needsRange && targets.length) {
            if (this.distance(player, targets[0]) > this.attackRange(player)) {
                throw new GameError('目标超出攻击范围。');
            }
        }

        ACTIVE_EFFECTS[skillId](this, player, spec, cards, targets, events);
        this.actionToken += 1;
        return this._result();
    }

    endTurn(userId, expectedToken = null) {
        const player = this._ensureTurn(userId, expectedToken, true);
        const events = this._ev;
        this._fire('on_turn_end', { player });
        const excess = player.hand.length - Math.max(0, player.hp);
        if (excess > 0) {
            this.pendingStack.push(new Pending({ kind: 'discard', deciderId: userId, data: { count: excess } }));
            events.push({ type: 'pending', kind: 'discard', decider_id: userId, note: `需弃 ${excess} 张手牌` });
        } else {
            this._completeTurnEnd(events);
        }
        this.actionToken += 1;
        return this._result();
    }

    // ------------------------------------------------ 响应结算

    resolvePending(userId, action, expectedToken = null) {
        if (!this.started || this.finished) throw new GameError('目前没有进行中的游戏。');
        this._checkToken(expectedToken);
        const top = this.pendingTop;
        if (!top) throw new GameError('现在没有等待响应的结算。');

        if (top.kind === 'nullify') {
            return this._resolveNullify(userId, action, expectedToken);
        }

        if (top.deciderId !== String(userId)) {
            const decider = this.player(top.deciderId);
            throw new GameError(`现在不需要你响应（轮到 ${decider.name}）。`);
        }

        const events = this._ev;
        const dispatch = {
            attack: this._resolveAttack.bind(this),
            aoe: this._resolveAoe.bind(this),
            duel: this._resolveDuel.bind(this),
            dying: this._resolveDying.bind(this),
            zone: this._resolveZone.bind(this),
            discard: this._resolveDiscard.bind(this),
            blade_pursue: this._resolveBladePursue.bind(this),
            bow_mount: this._resolveBowMount.bind(this),
        };
        dispatch[top.kind](top, action, events);
        this.actionToken += 1;
        return this._result();
    }

    autoresolveAction() {
        const top = this.pendingTop;
        if (!top) throw new GameError('现在没有等待响应的结算。');

        if (top.kind === 'nullify') return { type: 'pass' };

        if (top.kind === 'attack') {
            const player = this.player(top.deciderId);
            const armor = player.equipment[EquipmentSlot.ARMOR];
            if (armor && armor.name === '八卦阵') return { type: 'armor' };
            const options = this.responseOptions(player, '闪');
            if (options.length > 0) {
                const optCard = options[0][0];
                const idx = player.hand.indexOf(optCard);
                if (idx !== -1) return { type: 'dodge', card_index: idx };
            }
            return { type: 'pass' };
        }

        if (top.kind === 'aoe') {
            const player = this.player(top.deciderId);
            const needed = top.data.needed;
            const options = this.responseOptions(player, needed);
            if (options.length > 0) {
                const optCard = options[0][0];
                const idx = player.hand.indexOf(optCard);
                if (idx !== -1) return { type: 'play', card_index: idx };
            }
            return { type: 'pass' };
        }

        if (top.kind === 'duel') {
            const player = this.player(top.deciderId);
            const options = this.responseOptions(player, '杀');
            if (options.length > 0) {
                const optCard = options[0][0];
                const idx = player.hand.indexOf(optCard);
                if (idx !== -1) return { type: 'play', card_index: idx };
            }
            return { type: 'pass' };
        }

        if (top.kind === 'dying') {
            const player = this.player(top.deciderId);
            const idx = player.hand.findIndex(c => c.name === '桃');
            if (idx !== -1) return { type: 'peach', card_index: idx };
            return { type: 'decline' };
        }

        if (top.kind === 'zone') {
            const choices = this.zoneChoices();
            const pick = this._choice(choices);
            return { type: 'zone', ...pick.key };
        }

        if (top.kind === 'discard') {
            const player = this.player(top.deciderId);
            const indexes = Array.from({ length: player.hand.length }, (_, i) => i);
            return { type: 'discard', card_indexes: this._sample(indexes, top.data.count) };
        }

        if (top.kind === 'blade_pursue') return { type: 'pass' };

        if (top.kind === 'bow_mount') {
            const target = this.player(top.data.target_id);
            const mounts = [EquipmentSlot.OFFENSIVE_MOUNT, EquipmentSlot.DEFENSIVE_MOUNT].filter(s => target.equipment[s]);
            if (mounts.length > 0) return { type: 'dismount', slot: mounts[0] };
            return { type: 'pass' };
        }

        throw new GameError('未知的等待类型。');
    }

    autoresolve(expectedToken = null) {
        const top = this.pendingTop;
        if (!top) throw new GameError('现在没有等待响应的结算。');
        const uid = top.deciderId !== '0' ? top.deciderId : this.current.userId;
        return this.resolvePending(uid, this.autoresolveAction(), expectedToken);
    }

    // ------------------------------------------------ 无懈可击抢断栈

    _resolveNullify(userId, action, expectedToken = null) {
        const top = this.pendingTop;
        if (!top || top.kind !== 'nullify') throw new GameError('当前没有等待无懈可击抢断的锦囊。');
        const player = this.player(userId);
        if (!player.alive) throw new GameError('阵亡角色不能使用【无懈可击】。');

        const events = this._ev;
        const aType = action.type;

        if (aType === 'nullify') {
            const card = this._handCard(player, action.card_index);
            if (card.name !== '无懈可击') throw new GameError('你打出的不是【无懈可击】。');
            this.removeHandCard(player, card);
            this.discard.push(card);
            const trickName = top.data.trick_name;
            events.push({ type: 'nullify', player_id: player.userId, card_short: card.short, trick_name: trickName });
            events.push({ type: 'note', text: `${player.name} 抢出【无懈可击】，成功抵消了【${trickName}】！` });
            this.pendingStack = this.pendingStack.filter(p => p !== top);
        } else if (aType === 'pass') {
            const data = top.data;
            this.pendingStack = this.pendingStack.filter(p => p !== top);
            this._executeTrick(data, events);
        } else {
            throw new GameError('未知的抢断动作。');
        }

        this.actionToken += 1;
        return this._result();
    }

    _executeTrick(data, events) {
        const name = data.trick_name;
        const player = this.player(data.user_id);
        const target = data.target_id ? this.player(data.target_id) : null;

        if (name === '无中生有') {
            this.drawCards(player, 2);
        } else if (name === '过河拆桥') {
            if (!target || (!target.hand.length && !Object.keys(target.equipment).length && !target.delayed.length)) {
                events.push({ type: 'note', text: '目标已无牌可拆。' });
                return;
            }
            this.pendingStack.push(new Pending({ kind: 'zone', deciderId: player.userId, data: { target_id: target.userId, mode: 'discard', reason: name } }));
            events.push({ type: 'pending', kind: 'zone', decider_id: player.userId });
        } else if (name === '顺手牵羊') {
            if (!target || (!target.hand.length && !Object.keys(target.equipment).length && !target.delayed.length)) {
                events.push({ type: 'note', text: '目标已无牌可牵。' });
                return;
            }
            this.pendingStack.push(new Pending({ kind: 'zone', deciderId: player.userId, data: { target_id: target.userId, mode: 'steal', reason: name } }));
            events.push({ type: 'pending', kind: 'zone', decider_id: player.userId });
        } else if (name === '决斗') {
            if (!target || !target.alive) {
                events.push({ type: 'note', text: '决斗目标已不在场。' });
                return;
            }
            this.pendingStack.push(new Pending({ kind: 'duel', deciderId: target.userId, initiatorId: player.userId, data: { other_id: player.userId } }));
            events.push({ type: 'pending', kind: 'duel', decider_id: target.userId });
        } else if (name === '桃园结义') {
            const healed = [];
            for (const p of this.players) {
                if (p.alive && this.healPlayer(p, 1, events)) healed.push(p.name);
            }
            if (!healed.length) events.push({ type: 'note', text: '全员满血，没有人需要回复。' });
        } else if (name === '五谷丰登') {
            for (const p of this.players) {
                if (p.alive) this.drawCards(p, 1);
            }
        } else if (name === '南蛮入侵' || name === '万箭齐发') {
            this.launchAoe(player, name === '南蛮入侵' ? '杀' : '闪', name, events);
        }
    }

    // ------------------------------------------------ 攻击与武器判定响应

    _resolveAttack(top, action, events) {
        const decider = this.player(top.deciderId);
        const attacker = this._playerMaybe(top.initiatorId);
        const aType = action.type;

        if (aType === 'dodge') {
            const card = this._handCard(decider, action.card_index);
            const options = this.responseOptions(decider, '闪');
            const found = options.find(o => o[0] === card);
            if (!found) throw new GameError('这张牌不能当作【闪】打出。');
            this.removeHandCard(decider, card);
            this.discard.push(card);
            events.push({ type: 'dodge', player_id: decider.userId, card_short: card.short, note: found[1] || null });
            top.data.dodges_left -= 1;
            if (top.data.dodges_left <= 0) {
                this.pendingStack = this.pendingStack.filter(p => p !== top);
                this._afterDodge(decider, attacker, events);
            } else {
                events.push({ type: 'note', text: `还需再闪避 ${top.data.dodges_left} 次。` });
            }
        } else if (aType === 'armor') {
            const armor = decider.equipment[EquipmentSlot.ARMOR];
            if (!armor || armor.name !== '八卦阵') throw new GameError('你没有装备【八卦阵】。');
            const judged = this.judge(decider, '八卦阵', events);
            if (judged.color === '红色') {
                events.push({ type: 'dodge', player_id: decider.userId, card_short: null, note: '（【八卦阵】判定成功）' });
                top.data.dodges_left -= 1;
                if (top.data.dodges_left <= 0) {
                    this.pendingStack = this.pendingStack.filter(p => p !== top);
                    this._afterDodge(decider, attacker, events);
                } else {
                    events.push({ type: 'note', text: `还需再闪避 ${top.data.dodges_left} 次。` });
                }
            } else {
                events.push({ type: 'note', text: '八卦阵判定失败；可打出手牌【闪】或选择放弃。' });
            }
        } else if (aType === 'pass') {
            this.pendingStack = this.pendingStack.filter(p => p !== top);
            events.push({ type: 'note', text: `${decider.name} 放弃闪避。` });
            this.dealDamage(decider, top.data.damage, attacker, '杀', events);
            if (attacker && attacker.alive && decider.alive) {
                const w = attacker.equipment[EquipmentSlot.WEAPON];
                if (w && w.name === '麒麟弓') {
                    const mounts = [EquipmentSlot.OFFENSIVE_MOUNT, EquipmentSlot.DEFENSIVE_MOUNT].filter(s => decider.equipment[s]);
                    if (mounts.length > 0) {
                        this.pendingStack.push(new Pending({ kind: 'bow_mount', deciderId: attacker.userId, data: { target_id: decider.userId } }));
                        events.push({ type: 'pending', kind: 'bow_mount', decider_id: attacker.userId, note: '【麒麟弓】发动' });
                    }
                }
            }
        } else {
            throw new GameError('未知的响应动作。');
        }
    }

    _afterDodge(dodger, attacker, events) {
        if (attacker && attacker.alive) {
            this._fire('on_dodge_complete', { player: dodger, dodger, attacker });
            const weapon = attacker.equipment[EquipmentSlot.WEAPON];
            if (weapon && weapon.name === '青龙偃月刀' && dodger.alive) {
                const options = this.responseOptions(attacker, '杀');
                if (options.length > 0) {
                    this.pendingStack.push(new Pending({ kind: 'blade_pursue', deciderId: attacker.userId, initiatorId: dodger.userId, data: { target_id: dodger.userId } }));
                    events.push({ type: 'pending', kind: 'blade_pursue', decider_id: attacker.userId, note: '【青龙偃月刀】追击' });
                }
            }
        }
    }

    _resolveBladePursue(top, action, events) {
        const attacker = this.player(top.deciderId);
        const target = this.player(top.data.target_id);

        if (action.type === 'slash') {
            const card = this._handCard(attacker, action.card_index);
            const options = this.responseOptions(attacker, '杀');
            const found = options.find(o => o[0] === card);
            if (!found) throw new GameError('这张牌不能当作【杀】打出。');
            // 先校验后动栈：校验失败时保留追击窗口（原先删栈后校验，失败会让窗口蒸发+旧定时器误判超时）。
            this.pendingStack = this.pendingStack.filter(p => p !== top);
            this.removeHandCard(attacker, card);
            this.discard.push(card);
            events.push({ type: 'note', text: `${attacker.name} 发动【青龙偃月刀】追击，打出 ${card.short}！` });
            this._launchSingleAttack(attacker, card, target, events, '（青龙偃月刀追击）');
        } else if (action.type === 'pass') {
            this.pendingStack = this.pendingStack.filter(p => p !== top);
            events.push({ type: 'note', text: `${attacker.name} 放弃青龙偃月刀追击。` });
        } else {
            throw new GameError('未知的追击动作。');
        }
    }

    _resolveBowMount(top, action, events) {
        const attacker = this.player(top.deciderId);
        const target = this.player(top.data.target_id);

        if (action.type === 'dismount') {
            const slot = action.slot;
            if (!target.equipment[slot]) throw new GameError('目标没有该坐骑。');
            // 先校验后动栈（同青龙刀追击）。
            this.pendingStack = this.pendingStack.filter(p => p !== top);
            const mount = target.equipment[slot];
            delete target.equipment[slot];
            this.discard.push(mount);
            events.push({ type: 'note', text: `${attacker.name} 发动【麒麟弓】，射落了 ${target.name} 的坐骑 ${mount.short}！` });
        } else if (action.type === 'pass') {
            this.pendingStack = this.pendingStack.filter(p => p !== top);
            events.push({ type: 'note', text: `${attacker.name} 未发动麒麟弓拆马。` });
        } else {
            throw new GameError('未知的拆马动作。');
        }
    }

    _resolveAoe(top, action, events) {
        const decider = this.player(top.deciderId);
        const source = this._playerMaybe(top.data.source_id);
        const needed = top.data.needed;

        if (action.type === 'play') {
            const card = this._handCard(decider, action.card_index);
            const options = this.responseOptions(decider, needed);
            const found = options.find(o => o[0] === card);
            if (!found) throw new GameError(`这张牌不能当作【${needed}】打出。`);
            this.removeHandCard(decider, card);
            this.discard.push(card);
            events.push({ type: 'card_played', player_id: decider.userId, card_short: card.short, note: found[1] || null });
        } else if (action.type === 'pass') {
            events.push({ type: 'note', text: `${decider.name} 未响应。` });
            this.dealDamage(decider, 1, source, top.data.trick_name, events);
        } else {
            throw new GameError('未知的响应动作。');
        }
        top.data.awaiting = false;
    }

    _resolveDuel(top, action, events) {
        const decider = this.player(top.deciderId);
        const opponent = this._playerMaybe(top.data.other_id);

        if (action.type === 'play') {
            const card = this._handCard(decider, action.card_index);
            const options = this.responseOptions(decider, '杀');
            const found = options.find(o => o[0] === card);
            if (!found) throw new GameError('这张牌不能当作【杀】打出。');
            this.removeHandCard(decider, card);
            this.discard.push(card);
            events.push({ type: 'card_played', player_id: decider.userId, card_short: card.short, note: found[1] || null });
            top.data.other_id = decider.userId;
            top.deciderId = opponent ? opponent.userId : decider.userId;
        } else if (action.type === 'pass') {
            this.pendingStack = this.pendingStack.filter(p => p !== top);
            events.push({ type: 'note', text: `【决斗】结束，${decider.name} 败下阵来。` });
            this.dealDamage(decider, 1, opponent, '决斗', events);
        } else {
            throw new GameError('未知的响应动作。');
        }
    }

    _resolveDying(top, action, events) {
        const dying = this.player(top.data.dying_id);
        if (action.type === 'peach') {
            const decider = this.player(top.deciderId);
            const card = this._handCard(decider, action.card_index);
            if (card.name !== '桃') throw new GameError('濒死状态只能使用【桃】。');
            this.removeHandCard(decider, card);
            this.discard.push(card);
            this.healPlayer(dying, 1, events, '濒死求桃');
        } else if (action.type !== 'decline') {
            throw new GameError('未知的响应动作。');
        }
        top.data.awaiting = false;
    }

    zoneChoices() {
        const top = this.pendingTop;
        if (!top || top.kind !== 'zone') throw new GameError('目前没有在选择区域。');
        const target = this.player(top.data.target_id);
        const choices = [];
        if (target.hand.length > 0) {
            choices.push({ key: { zone: 'hand' }, label: '手牌（随机一张）' });
        }
        for (const [slot, card] of Object.entries(target.equipment)) {
            choices.push({ key: { zone: 'equip', slot }, label: `${card.short}（${slot}）` });
        }
        for (const card of target.delayed) {
            choices.push({ key: { zone: 'delayed', card_id: card.cardId }, label: `${card.short}（判定区）` });
        }
        return choices;
    }

    _resolveZone(top, action, events) {
        const decider = this.player(top.deciderId);
        const target = this.player(top.data.target_id);
        const zone = action.zone;
        let card = null;
        let label = '';

        if (zone === 'hand') {
            if (!target.hand.length) throw new GameError('目标没有手牌。');
            card = this._choice(target.hand);
            this.removeHandCard(target, card);
            label = '一张手牌（牌名保密）';
        } else if (zone === 'equip') {
            const slot = action.slot;
            if (!target.equipment[slot]) throw new GameError('目标没有这件装备。');
            card = target.equipment[slot];
            delete target.equipment[slot];
            this._onLoseArmor(target, card, events);
            label = `装备【${card.name}】`;
        } else if (zone === 'delayed') {
            const cid = action.card_id;
            const idx = target.delayed.findIndex(c => c.cardId === cid);
            if (idx === -1) throw new GameError('目标判定区没有这张牌。');
            card = target.delayed.splice(idx, 1)[0];
            label = `判定区的【${card.name}】`;
        } else {
            throw new GameError('未知的目标区域。');
        }

        this.pendingStack = this.pendingStack.filter(p => p !== top);
        if (top.data.mode === 'steal') {
            decider.hand.push(card);
            events.push({ type: 'steal', from_id: target.userId, to_id: decider.userId, zone_text: label, reason: top.data.reason });
        } else {
            this.discard.push(card);
            events.push({ type: 'steal', from_id: target.userId, to_id: null, zone_text: label, reason: top.data.reason });
        }
    }

    _resolveDiscard(top, action, events) {
        const decider = this.player(top.deciderId);
        const indexes = action.card_indexes || [];
        const need = top.data.count;
        if (indexes.length !== need) throw new GameError(`需要弃置 ${need} 张手牌。`);
        const cards = indexes.map(i => this._handCard(decider, i));
        if (new Set(cards.map(c => c.cardId)).size !== need) throw new GameError('不能重复指定同一张手牌。');

        for (const c of cards) {
            this.removeHandCard(decider, c);
            this.discard.push(c);
        }
        this.pendingStack = this.pendingStack.filter(p => p !== top);
        events.push({ type: 'discard', player_id: decider.userId, count: need });
        this._completeTurnEnd(events);
    }

    // ------------------------------------------------ 内部出牌与装备

    _playPeach(player, card, events) {
        if (player.hp >= player.maxHp) throw new GameError('你的体力已满。');
        this.removeHandCard(player, card);
        this.discard.push(card);
        this.healPlayer(player, 1, events);
        this._fire('on_peach', { player });
    }

    _equipCard(player, card, events) {
        this.removeHandCard(player, card);
        const slot = card.equipmentSlot;
        const old = player.equipment[slot];
        if (old) {
            this.discard.push(old);
            this._onLoseArmor(player, old, events);
        }
        player.equipment[slot] = card;
        events.push({ type: 'equip', player_id: player.userId, card_short: card.short, slot: slot, replaced_short: old ? old.short : null });
    }

    _onLoseArmor(player, card, events) {
        if (card.name === '白银狮子' && player.alive && player.hp < player.maxHp) {
            this.healPlayer(player, 1, events, '失去白银狮子');
        }
    }

    _placeDelayed(player, card, targetId, events) {
        const target = (card.name === '闪电' && !targetId) ? player : this._validOther(player, targetId);
        if (card.name === '兵粮寸断' && this.distance(player, target) > 1) {
            throw new GameError('【兵粮寸断】只能对距离 1 的角色使用。');
        }
        if (target.delayed.some(d => d.name === card.name)) {
            throw new GameError('目标的判定区已有同名延时锦囊。');
        }
        this.removeHandCard(player, card);
        target.delayed.push(card);
        events.push({ type: 'delayed_place', player_id: player.userId, target_id: target.userId, card_name: card.name });
    }

    _playTrick(player, card, targetId, events) {
        const name = card.name;
        if (!SUPPORTED_TRICKS.has(name)) throw new GameError('这张锦囊尚未支持。');
        let target = null;
        if (name === '过河拆桥' || name === '顺手牵羊' || name === '决斗') {
            target = this._validOther(player, targetId);
        }
        if ((name === '过河拆桥' || name === '顺手牵羊') && !target.hand.length && !Object.keys(target.equipment).length && !target.delayed.length) {
            throw new GameError('目标没有任何可获取或弃置的牌。');
        }
        if (name === '顺手牵羊' && this.distance(player, target) > 1) {
            throw new GameError('【顺手牵羊】只能对距离 1 的角色使用。');
        }

        this.removeHandCard(player, card);
        this.discard.push(card);
        events.push({ type: 'card_played', player_id: player.userId, card_short: card.short });
        this._fire('on_trick', { player, card });

        this.pendingStack.push(new Pending({
            kind: 'nullify', deciderId: '0', initiatorId: player.userId,
            data: { trick_name: name, target_id: target ? target.userId : null, user_id: player.userId, trick_card: card.toJSON() },
        }));
        events.push({ type: 'nullify_window', trick_name: name, seconds: 12 });
    }

    launchAoe(player, needed, trickName, events) {
        const queue = this._seatOrderFrom(player);
        if (!queue.length) {
            events.push({ type: 'note', text: '没有其他存活角色受影响。' });
            return;
        }
        const decider = queue.shift();
        this.pendingStack.push(new Pending({
            kind: 'aoe', deciderId: decider, initiatorId: player.userId,
            queue,
            data: { needed, source_id: player.userId, trick_name: trickName, awaiting: true },
        }));
        events.push({ type: 'pending', kind: 'aoe', decider_id: decider });
    }

    _launchSingleAttack(player, card, target, events, note = '') {
        const actual = this.distance(player, target);
        const reach = this.attackRange(player);
        if (actual > reach) throw new GameError(`目标距离为 ${actual}，超出目前攻击范围 ${reach}。`);

        const shown = card.short + (note || '');
        const armor = target.equipment[EquipmentSlot.ARMOR];
        if (armor && armor.name === '仁王盾' && card.color === '黑色') {
            events.push({ type: 'attack', attacker_id: player.userId, target_id: target.userId, card_short: shown, dodges: 0 });
            events.push({ type: 'attack_nullified', player_id: target.userId, card_short: shown });
            return;
        }

        const profile = { damage: 1, dodges: 1, pierce: false };
        this._fire('attack_profile', { player, attacker: player, card, profile });
        events.push({ type: 'attack', attacker_id: player.userId, target_id: target.userId, card_short: shown, dodges: profile.dodges, pierce: profile.pierce });

        if (profile.pierce) {
            this.dealDamage(target, profile.damage, player, '杀', events);
        } else {
            this.pendingStack.push(new Pending({
                kind: 'attack', deciderId: target.userId, initiatorId: player.userId,
                data: { damage: profile.damage, dodges_left: profile.dodges, card_short: shown },
            }));
            events.push({ type: 'pending', kind: 'attack', decider_id: target.userId });
        }
    }

    attackWithCard(player, card, target, events, note = '') {
        const weapon = player.equipment[EquipmentSlot.WEAPON];
        const unlimited = player.general === '张飞' || (weapon && weapon.name === '诸葛连弩');
        if (player.slashUsed && !unlimited) {
            throw new GameError('每回合只能使用一张【杀】；装备【诸葛连弩】可取消限制。');
        }
        this.removeHandCard(player, card);
        this.discard.push(card);
        player.slashUsed = true;
        this._launchSingleAttack(player, card, target, events, note);
    }

    // ------------------------------------------------ 伤害/濒死/阵亡

    dealDamage(target, amount, source, via, events) {
        if (!target.alive || this.finished) return;

        const armor = target.equipment[EquipmentSlot.ARMOR];
        if (armor && armor.name === '白银狮子' && amount > 1) {
            amount = 1;
            events.push({ type: 'note', text: `【白银狮子】生效，${target.name} 受到的伤害锁定为 1 点。` });
        }

        const ctx = { target, source, amount, prevented: false };
        this._fire('pre_damage', ctx);
        if (ctx.prevented) return;

        target.hp -= amount;
        events.push({ type: 'damage', target_id: target.userId, source_id: source ? source.userId : null, amount, hp: Math.max(0, target.hp), max_hp: target.maxHp, via });

        const pctx = { target, source, via };
        this._fireFor(target, 'post_damage_target', pctx);
        if (source && source.alive && source !== target) {
            this._fireFor(source, 'post_damage_source', pctx);
        }

        if (target.hp <= 0 && target.alive) {
            this._enterDying(target, source, events);
        }
    }

    loseHp(target, amount, killerId = null, reason = null, events = null) {
        if (!target.alive || this.finished) return;
        const ev = events || this._ev;
        target.hp -= amount;
        ev.push({ type: 'lose_hp', target_id: target.userId, amount, hp: Math.max(0, target.hp), max_hp: target.maxHp, reason });
        if (target.hp <= 0 && target.alive) {
            this._enterDying(target, this._playerMaybe(killerId), ev);
        }
    }

    _enterDying(target, source, events) {
        if (this.pendingStack.some(p => p.kind === 'dying' && p.data.dying_id === target.userId)) return;

        const askOrder = [target.userId, ...this._seatOrderFrom(target)];
        const peachHolders = askOrder.filter(uid => {
            const p = this.player(uid);
            return p.hand.some(c => c.name === '桃');
        });

        if (!peachHolders.length) {
            events.push({ type: 'note', text: `全场无人持有【桃】，${target.name} 阵亡。` });
            this._kill(target, source ? source.userId : null, events);
            return;
        }

        const decider = peachHolders[0];
        const queue = peachHolders.slice(1);
        this.pendingStack.push(new Pending({
            kind: 'dying', deciderId: decider, initiatorId: source ? source.userId : null,
            queue,
            data: { dying_id: target.userId, source_id: source ? source.userId : null, awaiting: true },
        }));
        events.push({ type: 'pending', kind: 'dying', decider_id: decider, note: `${target.name} 濒死求桃` });
    }

    _kill(player, killerId, events) {
        player.alive = false;
        events.push({ type: 'death', player_id: player.userId, role: player.role || '未知' });
        const killer = this._playerMaybe(killerId);

        if (killer && killer.alive && killer !== player) {
            if (player.role === Role.REBEL) {
                this.drawCards(killer, 3, '击杀反贼奖励');
            } else if (player.role === Role.LOYALIST && killer.role === Role.LORD) {
                const count = killer.hand.length + Object.keys(killer.equipment).length + killer.delayed.length;
                this.discard.push(...killer.hand);
                killer.hand = [];
                for (const c of Object.values(killer.equipment)) {
                    this.discard.push(c);
                    this._onLoseArmor(killer, c, events);
                }
                killer.equipment = {};
                this.discard.push(...killer.delayed);
                killer.delayed = [];
                if (count > 0) events.push({ type: 'discard', player_id: killer.userId, count });
                events.push({ type: 'note', text: `主公误杀忠臣，${killer.name} 弃置了全部牌。` });
            }
        }

        this.discard.push(...player.hand);
        player.hand = [];
        for (const c of Object.values(player.equipment)) {
            this.discard.push(c);
            this._onLoseArmor(player, c, events);
        }
        player.equipment = {};
        this.discard.push(...player.delayed);
        player.delayed = [];

        this._checkWinner(events);
    }

    _checkWinner(events) {
        if (this.finished || !this.started) return;
        const alive = this.players.filter(p => p.alive);
        const lordAlive = alive.some(p => p.role === Role.LORD);
        const rebelsAlive = alive.some(p => p.role === Role.REBEL);
        const renegadeAlive = alive.some(p => p.role === Role.RENEGADE);

        if (!lordAlive) {
            this.winner = (alive.length === 1 && alive[0].role === Role.RENEGADE) ? '内奸' : '反贼';
        } else if (!rebelsAlive && !renegadeAlive) {
            this.winner = '主公与忠臣';
        }

        if (this.winner) {
            this.finished = true;
            this.pendingStack = [];
            events.push({ type: 'winner', side: this.winner });
        }
    }

    // ------------------------------------------------ 共享原语

    drawCards(player, count, reason = null) {
        if (count <= 0) return;
        for (let i = 0; i < count; i++) {
            player.hand.push(this._takeTop());
        }
        this._ev.push({ type: 'draw', player_id: player.userId, count, reason });
    }

    removeHandCard(player, card, events = null) {
        const idx = player.hand.indexOf(card);
        if (idx !== -1) player.hand.splice(idx, 1);
        this._fire('on_hand_empty', { player });
    }

    healPlayer(player, amount, events = null, reason = null) {
        if (player.hp >= player.maxHp) return false;
        player.hp = Math.min(player.hp + amount, player.maxHp);
        const ev = events || this._ev;
        ev.push({ type: 'heal', target_id: player.userId, amount, hp: player.hp, max_hp: player.maxHp, reason });
        this._fire('on_heal', { player });
        return true;
    }

    _takeTop() {
        this._ensureDeck();
        return this.deck.pop();
    }

    _ensureDeck() {
        if (this.deck.length > 0) return;
        if (this.discard.length > 0) {
            this.deck = this.discard;
            this.discard = [];
            shuffleArray(this.deck, this.rng);
            return;
        }
        this.deckBatch += 1;
        this.deck = emergencyDeck(this.rng, this.deckBatch);
    }

    judge(owner, reason, events) {
        const card = this._takeTop();
        this.discard.push(card);
        events.push({ type: 'judgment', player_id: owner.userId, reason, card_short: card.short, color: card.color });
        return card;
    }

    responseOptions(player, needed) {
        const options = player.hand.filter(c => c.name === needed).map(c => [c, '']);
        this._fire('response_options', { player, needed, options });
        return options;
    }

    distance(source, target) {
        if (source === target) return 0;
        const living = this.players.filter(p => p.alive);
        const a = living.indexOf(source);
        const b = living.indexOf(target);
        if (a === -1 || b === -1) throw new GameError('无法计算已阵亡角色的距离。');
        const len = living.length;
        let base = Math.min((a - b + len) % len, (b - a + len) % len);
        if (source.equipment[EquipmentSlot.OFFENSIVE_MOUNT]) base -= 1;
        if (target.equipment[EquipmentSlot.DEFENSIVE_MOUNT]) base += 1;
        return Math.max(1, base);
    }

    attackRange(player) {
        const weapon = player.equipment[EquipmentSlot.WEAPON];
        return weapon ? weapon.weaponRange : 1;
    }

    _nextCardId() {
        this.idCounter += 1;
        return this.idCounter;
    }

    convertCard(card, newName, newType, slot = null) {
        return new Card({
            cardId: this._nextCardId(),
            name: newName,
            suit: card.suit,
            rank: card.rank,
            cardType: newType,
            equipmentSlot: slot,
            weaponRange: 1,
        });
    }

    // ------------------------------------------------ 流程控制

    _fire(trigger, ctx) {
        const table = TRIGGERS[trigger] || {};
        for (const p of this.players) {
            if (!p.alive) continue;
            const handler = table[p.general || ''];
            if (handler) {
                handler(this, { ...ctx, player: p, events: this._ev });
            }
        }
    }

    _fireFor(player, trigger, ctx) {
        const table = TRIGGERS[trigger] || {};
        const handler = table[player.general || ''];
        if (handler) {
            handler(this, { ...ctx, player, events: this._ev });
        }
    }

    _completeTurnEnd(events) {
        this._advanceTurnIndex();
        this._beginTurn();
    }

    _beginTurn() {
        for (const p of this.players) {
            p.emptyHandTriggered = false;
            p.damagePrevented = false;
        }
        const current = this.current;
        current.slashUsed = false;
        current.skillUsed = false;
        current.peachSkillUsed = false;
        current.skipPlay = false;
        current.skipDraw = false;
        current.damageBoost = false;

        const events = this._ev;
        this._processJudgments(current, events);
        if (this.pendingStack.length > 0) {
            this.beginInterrupted = true;
            return;
        }
        if (!current.alive) {
            this._advanceTurnIndex();
            events.push({ type: 'note', text: `回合自动移交给 ${this.current.name}。` });
            this._beginTurn();
            return;
        }
        this._drawPhase();
    }

    _drawPhase() {
        const current = this.current;
        const events = this._ev;
        let count = current.skipDraw ? 0 : 2;
        if (count > 0) {
            const ctx = { player: current, count };
            this._fire('draw_phase', ctx);
            count = ctx.count;
        }
        if (count > 0) {
            this.drawCards(current, count);
        }
        events.push({ type: 'turn', player_id: current.userId, draw_count: count });
    }

    _processJudgments(player, events) {
        // 延时锦囊按后入先出（LIFO）
        const copy = [...player.delayed].reverse();
        for (const delayed of copy) {
            if (!player.alive) break;
            player.delayed = player.delayed.filter(d => d !== delayed);
            if (delayed.name === '乐不思蜀') {
                this.discard.push(delayed);
                const judged = this.judge(player, delayed.name, events);
                if (judged.suit !== Suit.HEART) {
                    player.skipPlay = true;
                    events.push({ type: 'note', text: `${player.name} 本回合跳过出牌阶段。` });
                }
            } else if (delayed.name === '兵粮寸断') {
                this.discard.push(delayed);
                const judged = this.judge(player, delayed.name, events);
                if (judged.suit !== Suit.CLUB) {
                    player.skipDraw = true;
                    events.push({ type: 'note', text: `${player.name} 本回合跳过摸牌阶段。` });
                }
            } else if (delayed.name === '闪电') {
                const judged = this.judge(player, delayed.name, events);
                if (judged.suit === Suit.SPADE && judged.rank >= 2 && judged.rank <= 9) {
                    this.discard.push(delayed);
                    this.dealDamage(player, 3, null, '闪电', events);
                } else {
                    const nxt = this._nextLiving(player);
                    if (nxt && !nxt.delayed.some(d => d.name === '闪电')) {
                        nxt.delayed.push(delayed);
                        events.push({ type: 'note', text: `【闪电】移至 ${nxt.name} 的判定区。` });
                    } else {
                        this.discard.push(delayed);
                    }
                }
            }
        }
    }

    _advanceTurnIndex() {
        for (let offset = 1; offset <= this.players.length; offset++) {
            const idx = (this.turnIndex + offset) % this.players.length;
            if (this.players[idx].alive) {
                this.turnIndex = idx;
                return;
            }
        }
    }

    _nextLiving(player) {
        if (this.players.filter(p => p.alive).length <= 1) return null;
        const order = this._seatOrderFrom(player);
        return order.length ? this.player(order[0]) : null;
    }

    // ------------------------------------------------ 校验与收口

    _checkToken(expectedToken) {
        if (expectedToken !== null && expectedToken !== undefined && expectedToken !== this.actionToken) {
            throw new GameError('这个操作已经过期，请查看最新面板。');
        }
    }

    _checkStarted() {
        if (!this.started || this.finished) throw new GameError('目前没有进行中的游戏。');
    }

    _ensureTurn(userId, expectedToken = null, allowSkipped = false) {
        this._checkToken(expectedToken);
        this._checkStarted();
        const player = this.player(userId);
        if (!player.alive) throw new GameError('你已阵亡。');
        if (this.current.userId !== String(userId)) throw new GameError(`现在是 ${this.current.name} 的回合。`);
        if (this.pendingStack.length > 0) throw new GameError('请先等待当前结算完成。');
        if (player.skipPlay && !allowSkipped) throw new GameError('你受【乐不思蜀】影响，本回合不能出牌，请结束回合。');
        return player;
    }

    _handCard(player, index) {
        if (index === null || index === undefined || index < 0 || index >= player.hand.length) {
            throw new GameError('手牌编号无效。');
        }
        return player.hand[index];
    }

    _validOther(player, targetId) {
        const target = targetId ? this.player(targetId) : null;
        if (!target || !target.alive || target === player) throw new GameError('请指定一名其他存活角色。');
        return target;
    }

    _result() {
        const events = this._ev;
        this._finishPending(events);
        this._ev = [];
        return ActionResult.build(this, events);
    }

    _finishPending(events) {
        while (this.pendingStack.length > 0) {
            if (this.finished) {
                this.pendingStack = [];
                return;
            }
            const top = this.pendingStack[this.pendingStack.length - 1];

            if (top.kind === 'aoe') {
                if (top.data.awaiting) return;
                top.queue = top.queue.filter(pid => this.player(pid).alive);
                if (!top.queue.length) {
                    this.pendingStack.pop();
                    continue;
                }
                top.deciderId = top.queue.shift();
                top.data.awaiting = true;
                events.push({ type: 'pending', kind: 'aoe', decider_id: top.deciderId });
                return;
            }

            if (top.kind === 'dying') {
                const dying = this.player(top.data.dying_id);
                if (dying.hp >= 1) {
                    this.pendingStack.pop();
                    events.push({ type: 'note', text: `${dying.name} 脱离濒死。` });
                    continue;
                }
                if (top.data.awaiting) return;
                top.queue = top.queue.filter(pid => this.player(pid).alive);
                if (top.queue.length > 0) {
                    top.deciderId = top.queue.shift();
                    top.data.awaiting = true;
                    events.push({ type: 'pending', kind: 'dying', decider_id: top.deciderId });
                    return;
                }
                this.pendingStack.pop();
                const source = this._playerMaybe(top.data.source_id);
                this._kill(dying, source ? source.userId : null, events);
                continue;
            }

            return;
        }

        if (this.finished) return;

        if (!this.current.alive) {
            this.beginInterrupted = false;
            this._advanceTurnIndex();
            events.push({ type: 'note', text: `回合自动移交给 ${this.current.name}。` });
            this._beginTurn();
        } else if (this.beginInterrupted) {
            this.beginInterrupted = false;
            this._drawPhase();
        }
    }

    // ------------------------------------------------ UI 只读查询

    playHint(userId, cardIndex) {
        const player = this.player(userId);
        const card = this._handCard(player, cardIndex);

        if (card.name === '杀') {
            const reach = this.attackRange(player);
            const weapon = player.equipment[EquipmentSlot.WEAPON];
            const multi = Boolean(weapon && weapon.name === '方天画戟' && player.hand.length === 1);
            const targets = this._aliveOthers(player).filter(p => this.distance(player, p) <= reach).map(p => p.userId);
            return { playable: targets.length > 0, needsTarget: true, targets, multiTarget: multi };
        }
        if (card.name === '桃') {
            return { playable: player.hp < player.maxHp, needsTarget: false, targets: [] };
        }
        if (card.name === '闪' || card.name === '无懈可击') {
            return { playable: false, needsTarget: false, targets: [] };
        }
        if (card.cardType === CardType.EQUIPMENT) {
            return { playable: true, needsTarget: false, targets: [] };
        }
        if (card.cardType === CardType.DELAYED) {
            if (card.name === '闪电') {
                return { playable: !player.delayed.some(c => c.name === '闪电'), needsTarget: false, targets: [] };
            }
            if (card.name === '兵粮寸断') {
                const targets = this._aliveOthers(player).filter(p => this.distance(player, p) <= 1 && !p.delayed.some(c => c.name === '兵粮寸断')).map(p => p.userId);
                return { playable: targets.length > 0, needsTarget: true, targets };
            }
            if (card.name === '乐不思蜀') {
                const targets = this._aliveOthers(player).filter(p => !p.delayed.some(c => c.name === '乐不思蜀')).map(p => p.userId);
                return { playable: targets.length > 0, needsTarget: true, targets };
            }
            return { playable: true, needsTarget: true, targets: this._aliveOthers(player).map(p => p.userId) };
        }
        if (card.name === '顺手牵羊' || card.name === '过河拆桥') {
            const targets = this._aliveOthers(player).filter(p => {
                const hasCards = p.hand.length > 0 || Object.keys(p.equipment).length > 0 || p.delayed.length > 0;
                return hasCards && (card.name !== '顺手牵羊' || this.distance(player, p) <= 1);
            }).map(p => p.userId);
            return { playable: targets.length > 0, needsTarget: true, targets };
        }
        if (card.name === '决斗') {
            return { playable: true, needsTarget: true, targets: this._aliveOthers(player).map(p => p.userId) };
        }
        return { playable: true, needsTarget: false, targets: [] };
    }

    pendingOptions(userId) {
        const top = this.pendingTop;
        const uid = String(userId);
        if (!top) return { kind: null, playable: false, options: [] };

        if (top.kind === 'nullify') {
            const player = this.player(uid);
            const cards = player.hand.map((c, i) => ({ index: i, card: c })).filter(x => x.card.name === '无懈可击');
            return { kind: 'nullify', playable: cards.length > 0, cards, trickName: top.data.trick_name };
        }

        if (top.deciderId !== uid) return { kind: top.kind, playable: false, options: [] };

        const player = this.player(uid);
        if (top.kind === 'attack') {
            const cards = this.responseOptions(player, '闪');
            const armor = player.equipment[EquipmentSlot.ARMOR];
            return {
                kind: 'attack',
                playable: true,
                cards,
                hasEightDiagram: Boolean(armor && armor.name === '八卦阵'),
                dodgesLeft: top.data.dodges_left || 1,
            };
        }
        if (top.kind === 'aoe' || top.kind === 'duel') {
            const needed = (top.kind === 'aoe') ? top.data.needed : '杀';
            const cards = this.responseOptions(player, needed);
            return { kind: top.kind, playable: true, cards, needed };
        }
        if (top.kind === 'dying') {
            const cards = player.hand.map((c, i) => ({ index: i, card: c })).filter(x => x.card.name === '桃');
            return { kind: 'dying', playable: true, cards, dyingId: top.data.dying_id };
        }
        if (top.kind === 'zone') {
            return { kind: 'zone', playable: true, choices: this.zoneChoices(), targetId: top.data.target_id };
        }
        if (top.kind === 'discard') {
            return { kind: 'discard', playable: true, need: top.data.count, handCount: player.hand.length };
        }
        if (top.kind === 'blade_pursue') {
            const cards = this.responseOptions(player, '杀');
            return { kind: 'blade_pursue', playable: true, cards, targetId: top.data.target_id };
        }
        if (top.kind === 'bow_mount') {
            const target = this.player(top.data.target_id);
            const mounts = [EquipmentSlot.OFFENSIVE_MOUNT, EquipmentSlot.DEFENSIVE_MOUNT]
                .filter(s => target.equipment[s])
                .map(s => ({ slot: s, card: target.equipment[s] }));
            return { kind: 'bow_mount', playable: true, mounts, targetId: target.userId };
        }

        return { kind: top.kind, playable: false, options: [] };
    }

    publicView() {
        const top = this.pendingTop;
        const turnPlayer = this.started ? this.current : this.players[0];
        return {
            started: this.started,
            finished: this.finished,
            winner: this.winner,
            turnUserId: turnPlayer ? turnPlayer.userId : this.ownerId,
            turnName: turnPlayer ? turnPlayer.name : '',
            deckCount: this.deck.length + this.discard.length,
            pendingKind: top ? top.kind : null,
            pendingDeciderId: top ? top.deciderId : null,
            pendingDeciderName: (top && top.deciderId !== '0') ? this.player(top.deciderId).name : '',
            pendingData: top ? top.data : {},
            players: this.players.map(p => {
                const roleShown = (p.role === Role.LORD || !p.alive || this.finished) && p.role ? p.role : '？';
                const equipObj = {};
                for (const [s, c] of Object.entries(p.equipment)) equipObj[s] = c.short;
                return {
                    userId: p.userId,
                    name: p.name,
                    alive: p.alive,
                    hp: p.hp,
                    maxHp: p.maxHp,
                    handCount: p.hand.length,
                    role: roleShown,
                    general: p.general,
                    equipment: equipObj,
                    delayed: p.delayed.map(c => c.name),
                    autoPlay: p.autoPlay,
                };
            }),
        };
    }

    privateView(userId) {
        const player = this.player(userId);
        return {
            userId: player.userId,
            name: player.name,
            role: player.role || '？',
            general: player.general,
            hp: player.hp,
            maxHp: player.maxHp,
            hand: [...player.hand],
            equipment: { ...player.equipment },
            delayed: player.delayed.map(c => c.name),
            attackRange: this.attackRange(player),
            skill: player.general ? GENERALS[player.general] : null,
            alive: player.alive,
            autoPlay: player.autoPlay,
        };
    }
}

function createSeededRng(seed) {
    let s = Number(seed) || 123456789;
    return function() {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
    };
}

module.exports = {
    Game,
    Player,
    Card,
    Pending,
    ActionResult,
    GameError,
    Suit,
    SuitSymbol,
    CardType,
    EquipmentSlot,
    Role,
    ROLE_TABLE,
    SUPPORTED_TRICKS,
    SLASH_LIKE_SKILLS,
    GENERAL_LIST,
    GENERALS,
    ACTIVE_SKILLS,
    ACTIVE_SKILLS_BY_GENERAL,
    buildDeck,
    emergencyDeck,
};
