const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getRandomChampions, getCacheInfo } = require('../services/lolPsService');

const LANE_LABELS = {
  TOP: '🛡️ 탑',
  JUNGLE: '🌲 정글',
  MID: '✨ 미드',
  ADC: '🏹 바텀',
  SUPPORT: '💖 서폿',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('랜덤챔피언')
    .setDescription('lol.ps 기준으로 라인에서 랜덤 챔피언을 뽑습니다')
    .addStringOption((opt) =>
      opt
        .setName('라인')
        .setDescription('뽑을 라인을 선택하세요')
        .setRequired(true)
        .addChoices(
          { name: '탑', value: 'TOP' },
          { name: '정글', value: 'JUNGLE' },
          { name: '미드', value: 'MID' },
          { name: '바텀', value: 'ADC' },
          { name: '서폿', value: 'SUPPORT' }
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName('개수')
        .setDescription('뽑을 챔피언 수 (기본 1, 최대 10)')
        .setMinValue(1)
        .setMaxValue(10)
    ),

  async execute(interaction) {
    const lane = interaction.options.getString('라인');
    const count = interaction.options.getInteger('개수') || 1;

    const cacheInfo = getCacheInfo();
    if (!cacheInfo.loaded) {
      return interaction.reply({
        content: '❌ 챔피언 데이터가 아직 로드되지 않았습니다. 잠시 후 다시 시도해주세요.',
        ephemeral: true,
      });
    }

    try {
      const picks = getRandomChampions(lane, count);
      const laneLabel = LANE_LABELS[lane] || lane;

      const description =
        count === 1
          ? `## ${picks[0]}`
          : picks.map((name, i) => `**${i + 1}.** ${name}`).join('\n');

      const embed = new EmbedBuilder()
        .setTitle(`🎲 ${laneLabel} 랜덤 챔피언`)
        .setDescription(description)
        .setColor(0x5865f2)
        .setFooter({
          text: `lol.ps 기준 · ${laneLabel} 풀 ${cacheInfo.counts[lane]}명 중 ${picks.length}명`,
        });

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply({
        content: `❌ ${err.message}`,
        ephemeral: true,
      });
    }
  },
};
