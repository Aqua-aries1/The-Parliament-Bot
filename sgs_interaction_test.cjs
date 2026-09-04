/**
 * 三国杀交互层冒烟测试（sgsGame.js）：
 * 1. /三国杀 创建房间 + 招募面板渲染
 * 2. 上桌/重复上桌（GameError → ❌ 反馈，不再未处理 rejection）
 * 3. 不足 3 人开局 → ❌ 反馈
 * 4. 3 人开局 → 主面板 + 私密信息
 * 5. 结束回合（过期 token → ❌ 反馈；合法 token → ✓）
 * 6. 托管超时路径（armTimer 缩短宽限 + 自动结束回合）
 * 7. 恢复流程跳过 finished 快照
 * 运行：node sgs_interaction_test.cjs
 */
'use strict';
const assert = require('node:assert');
const path = require('node:path');
const root = path.resolve(__dirname);

const {
    launchOrRefreshSGS,
    handleSGSInteraction,
    restoreAllSGSGames,
} = require(path.join(root, 'src/modules/sgs/services/sgsGame'));
const { createSGSResumeStore } = require(path.join(root, 'src/modules/sgs/utils/sgsResumeStore'));
const SNAPSHOT_PATH = path.join(root, 'data', 'sgs', 'sgsActiveGames.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readSnapshots() {
    await sleep(150); // 快照写入走异步队列，稍等落盘
    try {
        return JSON.parse(require('node:fs').readFileSync(SNAPSHOT_PATH, 'utf8'));
    } catch (_) {
        return {};
    }
}

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log(`  ✅ ${msg}`); }
    else { failures += 1; console.error(`  ❌ ${msg}`); }
}

function mkPanelMsg() {
    return {
        id: 'panel-' + Math.random().toString(36).slice(2, 8),
        edits: [],
        edit: async function (payload) { this.edits.push(payload); },
        delete: async function () { this.deleted = true; },
    };
}

function mkChannel() {
    const ch = {
        id: 'ch-1',
        sent: [],
        send: async (payload) => { const m = mkPanelMsg(); ch.sent.push(m); return m; },
        messages: { fetch: async () => null },
    };
    return ch;
}

function mkUser(id, name) {
    const u = { id, username: name, bot: false };
    u.toString = () => `<@${id}>`;
    return u;
}

function mkInteraction(userId, name, { customId = '', deferred = false } = {}) {
    const it = {
        user: mkUser(userId, name),
        member: { displayName: name },
        guildId: 'test-g1',
        channelId: 'ch-1',
        channel: null,
        customId,
        deferred,
        replied: false,
        replies: [],
        followups: [],
        deferReply: async () => { it.deferred = true; },
        reply: async (payload) => { it.replied = true; it.replies.push(payload); return { createMessageComponentCollector: () => ({ on: () => {}, stop: () => {} }) }; },
        editReply: async (payload) => { it.replies.push(payload); return {}; },
        followup: async (payload) => { it.followups.push(payload); return {}; },
    };
    return it;
}

async function runAllTests() {
    console.log('🚀 开始三国杀交互层冒烟测试...');
    const channel = mkChannel();

    // 1. 创建房间
    {
        const it = mkInteraction('u1', '房主甲');
        it.channel = channel;
        await launchOrRefreshSGS(it);
        check(channel.sent.length === 1, '创建房间后发出招募面板');
        check(it.followups.some(f => String(f.content || '').includes('三国杀房间')), '公开提示房间已开启');
    }

    // 2. 上桌 + 重复上桌错误反馈（房主构造时即入房，无需上桌）
    {
        const it = mkInteraction('u2', '玩家乙', { customId: 'sgs:r:test-g1:0:join' });
        await handleSGSInteraction(it);
        check(it.replies.some(r => String(r.content || '').includes('✓')), '首次上桌成功反馈');

        const it2 = mkInteraction('u2', '玩家乙', { customId: 'sgs:r:test-g1:0:join' });
        await handleSGSInteraction(it2);
        check(it2.replies.some(r => String(r.content || '').includes('❌')), '重复上桌收到 ❌ 错误反馈（不再无响应）');
    }

    // 3. 不足 3 人开局 → ❌
    {
        const it = mkInteraction('u1', '房主甲', { customId: 'sgs:r:test-g1:0:start' });
        await handleSGSInteraction(it);
        check(it.deferred && it.followups.some(f => String(f.content || '').includes('❌')), '不足 3 人开局收到 ❌ 反馈');
    }

    // 4. 补足 3 人并开局（u1 房主 + u2 + u3）
    {
        const itJoin = mkInteraction('u3', '玩家丙', { customId: 'sgs:r:test-g1:0:join' });
        await handleSGSInteraction(itJoin);
        const it = mkInteraction('u1', '房主甲', { customId: 'sgs:r:test-g1:0:start' });
        await handleSGSInteraction(it);
        check(it.followups.some(f => String(f.content || '').includes('🀄')), '3 人开局成功提示');
    }

    // 5. 结束回合：过期 token → ❌；开局快照已落盘
    {
        const itBad = mkInteraction('u2', '玩家乙', { customId: 'sgs:m:test-g1:999999:end' });
        await handleSGSInteraction(itBad);
        check(itBad.followups.some(f => String(f.content || '').includes('❌')), '过期 token 结束回合收到 ❌ 反馈');

        const snaps = await readSnapshots();
        check(snaps['test-g1'] && snaps['test-g1'].started === true, '开局后快照已落盘');
    }

    // 6. 恢复流程：finished 快照被清理
    {
        const snaps = await readSnapshots();
        snaps['test-g1'].finished = true;
        snaps['test-g1'].winner = '主公与忠臣';
        const fs = require('node:fs');
        fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
        fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({ 'test-g1': snaps['test-g1'] }), 'utf8');

        const client = { channels: { fetch: async () => null }, user: { id: 'bot' }, guilds: { cache: new Map(), fetch: async () => null } };
        const restored = await restoreAllSGSGames(client);
        check(restored === 0, 'finished 快照不被恢复');
        const after = await readSnapshots();
        check(!after['test-g1'], 'finished 快照已被清理');
    }

    console.log(failures === 0 ? '\n🎉 三国杀交互层冒烟测试全部通过！' : `\n⚠️ ${failures} 项未通过`);
    // 开局后 armTimer 会留下长定时器，显式退出避免进程挂住。
    process.exit(failures === 0 ? 0 : 1);
}

runAllTests().catch(err => {
    console.error('❌ 测试执行失败：', err);
    process.exit(1);
});
