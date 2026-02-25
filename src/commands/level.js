const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');
const {
  getUserData,
  getLeaderboard,
  getUserRank,
  xpForNextLevel,
} = require('../services/levelService');
require('dotenv').config();

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('레벨')
    .setDescription('레벨/경험치 시스템')
    .addSubcommand((sub) =>
      sub.setName('내정보').setDescription('내 레벨과 경험치를 확인합니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('순위')
        .setDescription('서버 레벨 순위표를 확인합니다 (TOP 10)')
    )
    .addSubcommand((sub) =>
      sub
        .setName('정보')
        .setDescription('다른 유저의 레벨을 확인합니다')
        .addUserOption((opt) =>
          opt
            .setName('유저')
            .setDescription('확인할 유저')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case '내정보':
        return this.myInfo(interaction);
      case '순위':
        return this.leaderboard(interaction);
      case '정보':
        return this.userInfo(interaction);
    }
  },

  // ============================================
  // 📊 내 정보
  // ============================================
  async myInfo(interaction) {
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const data = await getUserData(guildId, userId);
    const rank = await getUserRank(guildId, userId);
    const nextLevelXp = xpForNextLevel(data.level);

    // 📈 진행도 바
    const progress = nextLevelXp > 0 ? data.xp / nextLevelXp : 0;
    const filled = Math.min(Math.round(progress * 10), 10);
    const progressBar = '█'.repeat(filled) + '░'.repeat(10 - filled);

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${interaction.member.displayName}의 레벨 정보`)
      .setThumbnail(
        interaction.user.displayAvatarURL({ dynamic: true, size: 256 })
      )
      .addFields(
        { name: '⭐ 레벨', value: `${data.level}`, inline: true },
        {
          name: '✨ 경험치',
          value: `${data.xp} / ${nextLevelXp} XP`,
          inline: true,
        },
        { name: '🏆 순위', value: `#${rank}`, inline: true },
        {
          name: '💬 총 메시지',
          value: `${data.messageCount}개`,
          inline: true,
        },
        {
          name: '📈 진행도',
          value: `${progressBar} ${Math.round(progress * 100)}%`,
        }
      )
      .setColor(0x5865f2)
      .setTimestamp();

    // 리더보드 버튼
    const lbUrl = `${DASHBOARD_URL}/leaderboard.html?guild=${guildId}&user=${userId}`;
    const button = new ButtonBuilder()
      .setLabel('서버 순위표 보기')
      .setStyle(ButtonStyle.Link)
      .setURL(lbUrl)
      .setEmoji('🏆');
    const row = new ActionRowBuilder().addComponents(button);

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  },

  // ============================================
  // 🏆 순위표
  // ============================================
  async leaderboard(interaction) {
    const guildId = interaction.guild.id;
    const userId  = interaction.user.id;
    const top = await getLeaderboard(guildId, 10);

    if (top.length === 0) {
      return interaction.reply({
        content: '📊 아직 레벨 데이터가 없습니다. 채팅을 시작해보세요!',
        ephemeral: true,
      });
    }

    const medals = ['🥇', '🥈', '🥉'];
    const description = top
      .map((user, i) => {
        const medal = medals[i] || `**${i + 1}.**`;
        return `${medal} <@${user.userId}> — 레벨 ${user.level} | ${user.xp} XP | 💬 ${user.messageCount}개`;
      })
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`🏆 ${interaction.guild.name} 레벨 순위표`)
      .setDescription(description)
      .setColor(0xffd700)
      .setFooter({ text: `TOP ${top.length}명 표시` })
      .setTimestamp();

    // 리더보드 웹 페이지 버튼
    const lbUrl = `${DASHBOARD_URL}/leaderboard.html?guild=${guildId}&user=${userId}`;
    const button = new ButtonBuilder()
      .setLabel('리더보드 보기')
      .setStyle(ButtonStyle.Link)
      .setURL(lbUrl)
      .setEmoji('🏆');

    const row = new ActionRowBuilder().addComponents(button);

    await interaction.reply({ embeds: [embed], components: [row] });
  },

  // ============================================
  // 🔍 유저 정보
  // ============================================
  async userInfo(interaction) {
    const targetUser = interaction.options.getUser('유저');
    const targetMember = interaction.options.getMember('유저');
    const guildId = interaction.guild.id;

    if (targetUser.bot) {
      return interaction.reply({
        content: '❌ 봇의 레벨은 확인할 수 없습니다.',
        ephemeral: true,
      });
    }

    const data = await getUserData(guildId, targetUser.id);
    const rank = await getUserRank(guildId, targetUser.id);
    const nextLevelXp = xpForNextLevel(data.level);

    // 📈 진행도 바
    const progress = nextLevelXp > 0 ? data.xp / nextLevelXp : 0;
    const filled = Math.min(Math.round(progress * 10), 10);
    const progressBar = '█'.repeat(filled) + '░'.repeat(10 - filled);

    const embed = new EmbedBuilder()
      .setTitle(
        `📊 ${targetMember?.displayName || targetUser.username}의 레벨 정보`
      )
      .setThumbnail(
        targetUser.displayAvatarURL({ dynamic: true, size: 256 })
      )
      .addFields(
        { name: '⭐ 레벨', value: `${data.level}`, inline: true },
        {
          name: '✨ 경험치',
          value: `${data.xp} / ${nextLevelXp} XP`,
          inline: true,
        },
        { name: '🏆 순위', value: `#${rank}`, inline: true },
        {
          name: '💬 총 메시지',
          value: `${data.messageCount}개`,
          inline: true,
        },
        {
          name: '📈 진행도',
          value: `${progressBar} ${Math.round(progress * 100)}%`,
        }
      )
      .setColor(0x5865f2)
      .setTimestamp();

    // 리더보드 버튼
    const lbUrl = `${DASHBOARD_URL}/leaderboard.html?guild=${guildId}&user=${targetUser.id}`;
    const button = new ButtonBuilder()
      .setLabel('서버 순위표 보기')
      .setStyle(ButtonStyle.Link)
      .setURL(lbUrl)
      .setEmoji('🏆');
    const row = new ActionRowBuilder().addComponents(button);

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  },
};
