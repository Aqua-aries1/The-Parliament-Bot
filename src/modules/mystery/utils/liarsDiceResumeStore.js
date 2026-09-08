// 骗子骰子对局快照存储：直接复用恶魔轮盘的原子写快照工厂（临时文件 + rename + 串行队列），
// 只换落盘路径与日志前缀。接口与旧版完全一致：save/remove/list/load/flush。
const path = require('node:path');
const { createDevilRouletteResumeStore } = require('./devilRouletteResumeStore');

const defaultStore = createDevilRouletteResumeStore({
    filePath: path.join('data', 'mystery', 'liarsDiceActiveGames.json'),
    logTag: 'LiarsDiceResume',
});

module.exports = {
    save: defaultStore.save,
    remove: defaultStore.remove,
    list: defaultStore.list,
    load: defaultStore.load,
    flush: defaultStore.flush,
};
