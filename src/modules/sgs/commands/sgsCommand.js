/**
 * 顶级独立斜杠指令：/三国杀（无需任何神秘指令前缀）
 */

const { SlashCommandBuilder } = require('discord.js');
const { launchOrRefreshSGS } = require('../services/sgsGame');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('三国杀')
        .setDescription('开启或置顶刷新三国杀游戏房间（全部操作集成在嵌入面板与按钮上）'),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: '请在服务器文字频道中使用此指令。', ephemeral: true });
            return;
        }
        await launchOrRefreshSGS(interaction);
    },
};
