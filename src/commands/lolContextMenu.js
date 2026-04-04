const {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
} = require('discord.js');
const {
  fetchRecentMatchData,
} = require('../services/riotService');
const {
  analyzeRecentMatches,
  parseAnalysisToFields,
} = require('../services/lolAnalyzer');
const { hasCredit, useCredit, getCredits } = require('../services/membershipService');
const { getRegisteredPlayers } = require('../services/lolTrackerService');

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('전적 검색')
    .setType(ApplicationCommandType.User),

  async execute(interaction) {
    const targetUser = interaction.targetUser;

    // 등록된 소환사인지 먼저 확인
    const players = await getRegisteredPlayers(interaction.guild.id);
    const registered = players[targetUser.id];

    if (registered) {
      // 등록된 유저 → 바로 검색
      return this.searchDirect(interaction, registered.gameName, registered.tagLine, targetUser);
    }

    // 미등록 유저 → 모달로 소환사명 입력 받기
    const modal = new ModalBuilder()
      .setCustomId(`lol_search_modal_${targetUser.id}`)
      .setTitle(`${targetUser.displayName} 전적 검색`);

    const nameInput = new TextInputBuilder()
      .setCustomId('summoner_name')
      .setLabel('소환사명')
      .setPlaceholder('예: Hide on bush')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const tagInput = new TextInputBuilder()
      .setCustomId('summoner_tag')
      .setLabel('태그')
      .setPlaceholder('예: KR1')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(10);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(tagInput),
    );

    await interaction.showModal(modal);
  },

  // 등록된 유저 → 바로 전적 검색
  async searchDirect(interaction, gameName, tagLine, targetUser) {
    // 크레딧 체크
    if (!(await hasCredit(interaction.guild.id, interaction.user.id))) {
      const remaining = await getCredits(interaction.guild.id, interaction.user.id);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ 크레딧 부족')
            .setDescription(
              `AI 분석 크레딧이 부족합니다. (잔여: ${remaining}회)\n\n\`/멤버십 구매\`로 크레딧을 충전해주세요.`
            )
            .setColor(0xff0000),
        ],
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const credits = await getCredits(interaction.guild.id, interaction.user.id);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🔍 전적을 가져오는 중...')
            .setDescription(
              `<@${targetUser.id}>님의 **${gameName}#${tagLine}** 최근 5게임을 분석 중입니다.\n잠시만 기다려주세요... (약 15~40초)\n\n💳 잔여 크레딧: ${credits}회`
            )
            .setColor(0xffa500),
        ],
      });

      const matchData = await fetchRecentMatchData(gameName, tagLine, 5);

      if (matchData.matches.length === 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ 전적을 찾을 수 없습니다')
              .setDescription('최근 게임 기록이 없습니다.')
              .setColor(0xff0000),
          ],
        });
      }

      const analysis = await analyzeRecentMatches(matchData);
      const analysisFields = parseAnalysisToFields(analysis);

      await useCredit(interaction.guild.id, interaction.user.id, '우클릭 전적 검색');

      const wins = matchData.matches.filter((m) => m.win).length;
      const losses = matchData.matches.length - wins;

      const profileEmbed = new EmbedBuilder()
        .setTitle(`📊 ${gameName}#${tagLine} 전적 분석`)
        .setDescription(`<@${targetUser.id}>님의 전적 (우클릭 검색)`)
        .addFields(
          { name: '🏆 랭크', value: matchData.rank, inline: true },
          { name: '📈 레벨', value: `${matchData.summonerLevel}`, inline: true },
          {
            name: `📊 최근 ${matchData.matches.length}게임`,
            value: `${wins}승 ${losses}패 (${Math.round((wins / matchData.matches.length) * 100)}%)`,
            inline: true,
          }
        )
        .setColor(0x5865f2)
        .setTimestamp();

      const matchList = matchData.matches
        .map(
          (m) =>
            `${m.win ? '✅' : '❌'} **${m.champion}** | ${m.kills}/${m.deaths}/${m.assists} (${m.kda}) | CS ${m.cs} (${m.csPerMin}/분) | ${m.duration}`
        )
        .join('\n');

      const matchEmbed = new EmbedBuilder()
        .setTitle('📋 매치 히스토리')
        .setDescription(matchList.substring(0, 4096))
        .setColor(0x1a78ae);

      const analysisEmbed = new EmbedBuilder()
        .setTitle('🤖 AI 분석')
        .setColor(0xf0b232)
        .setFooter({ text: 'AI 분석 | 우클릭 전적 검색' })
        .setTimestamp();
      for (const f of analysisFields.slice(0, 25)) {
        analysisEmbed.addFields(f);
      }

      await interaction.editReply({
        embeds: [profileEmbed, matchEmbed, analysisEmbed],
      });
    } catch (err) {
      console.error('우클릭 전적 검색 오류:', err);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ 오류 발생')
            .setDescription(err.userMessage || err.message || '알 수 없는 오류')
            .setColor(0xff0000),
        ],
      });
    }
  },
};
