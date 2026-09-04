/**
 * 三国杀对局快照存储（断点续传）。
 * 存储路径默认为 data/sgs/sgsActiveGames.json：
 * - 每次状态变更/渲染后 save(gameId, snapshot)；
 * - 对局结束或解散后 remove(gameId)；
 * - 启动时 list() 读回全部对局快照并恢复。
 * 写入采用「临时文件 + rename」原子替换与 Promise 串行队列，防止坏档。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

let temporaryFileSequence = 0;

function logFailure(operation, error) {
    console.error(`[SGSResume] ${operation} failed:`, error);
}

function createSGSResumeStore({ filePath, now = Date.now } = {}) {
    const resolvedPath = filePath || path.join(process.cwd(), 'data', 'sgs', 'sgsActiveGames.json');
    let snapshots = {};
    let writeQueue = Promise.resolve();

    async function ensureDirectory() {
        try {
            await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
            return true;
        } catch (error) {
            logFailure('creating resume directory', error);
            return false;
        }
    }

    async function writeSnapshot() {
        if (!await ensureDirectory()) return;
        const temporaryPath = `${resolvedPath}.${process.pid}.${Date.now()}.${temporaryFileSequence++}.tmp`;
        const payload = JSON.stringify(snapshots);
        try {
            await fs.writeFile(temporaryPath, payload, 'utf8');
        } catch (error) {
            logFailure('writing temporary resume file', error);
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') logFailure('cleaning up temporary resume file', cleanupError);
            }
            return;
        }
        try {
            await fs.rename(temporaryPath, resolvedPath);
        } catch (error) {
            logFailure('renaming temporary resume file', error);
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') logFailure('cleaning up temporary resume file', cleanupError);
            }
        }
    }

    function queueWrite() {
        writeQueue = writeQueue.then(
            () => writeSnapshot(),
            () => writeSnapshot(),
        );
        return writeQueue;
    }

    async function backupMalformedFile() {
        const parsed = path.parse(resolvedPath);
        const backupPath = path.join(parsed.dir, `${parsed.name}.corrupt-${now()}${parsed.ext}`);
        try {
            await fs.rename(resolvedPath, backupPath);
            return true;
        } catch (error) {
            logFailure('backing up malformed resume file', error);
            return false;
        }
    }

    async function load() {
        try {
            await writeQueue;
        } catch (error) {
            logFailure('waiting before resume load', error);
        }
        if (!await ensureDirectory()) {
            snapshots = {};
            return;
        }
        let serialized;
        try {
            serialized = await fs.readFile(resolvedPath, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') logFailure('reading resume file', error);
        }
        if (serialized !== undefined) {
            try {
                const value = JSON.parse(serialized);
                if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Resume data must be a JSON object');
                snapshots = value;
            } catch (error) {
                logFailure('parsing resume file', error);
                await backupMalformedFile();
                snapshots = {};
            }
        }
    }

    function save(gameId, snapshot) {
        if (!gameId || !snapshot || typeof snapshot !== 'object') return;
        snapshots[String(gameId)] = { ...snapshot, savedAt: now() };
        void queueWrite();
    }

    function remove(gameId) {
        const key = String(gameId);
        if (key && Object.hasOwn(snapshots, key)) {
            delete snapshots[key];
            void queueWrite();
        }
    }

    async function list() {
        await load();
        return { ...snapshots };
    }

    return {
        save,
        remove,
        list,
        load,
        filePath: resolvedPath,
    };
}

module.exports = {
    createSGSResumeStore,
};
