const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getRandomChampions, getCacheInfo } = require('../services/lolPsService');

const LANE_LABELS = {
  TOP: '🛡️ 탑',
  JUNGLE: '🌲 정글',
  MID: '✨ 미드',
  ADC: '🏹 바텀',
  SUPPORT: '💖 서폿',
  ALL: '🎯 모두',
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
          { name: '서폿', value: 'SUPPORT' },
          { name: '모두', value: 'ALL' }
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
      const isAll = lane === 'ALL';
      const anyJackpot = picks.some((p) => p.jackpot);

      const formatPick = (p) =>
        p.jackpot ? `💥 **꽝!** ${p.name} \`(전체 풀)\`` : p.name;

      const description =
        count === 1
          ? picks[0].jackpot
            ? `## 💥 꽝!\n## ${picks[0].name}\n*전체 챔피언 풀에서 뽑혔습니다*`
            : `## ${picks[0].name}`
          : picks.map((p, i) => `**${i + 1}.** ${formatPick(p)}`).join('\n');

      const footerText = isAll
        ? `lol.ps 기준 · 전체 챔피언 풀 ${cacheInfo.allCount}명 (꽝 없음)`
        : `lol.ps 기준 · ${laneLabel} 풀 ${cacheInfo.counts[lane]}명 + 꽝 1칸 (1/${cacheInfo.counts[lane] + 1})`;

      const embed = new EmbedBuilder()
        .setTitle(`🎲 ${laneLabel} 랜덤 챔피언`)
        .setDescription(description)
        .setColor(anyJackpot ? 0xed4245 : 0x5865f2)
        .setFooter({ text: footerText });

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply({
        content: `❌ ${err.message}`,
        ephemeral: true,
      });
    }
  },
};
