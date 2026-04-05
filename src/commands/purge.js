const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('청소')
    .setDescription('채널의 메시지를 삭제합니다 (14일 이내만 가능)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) =>
      sub
        .setName('개수')
        .setDescription('지정한 개수만큼 메시지를 삭제합니다')
        .addIntegerOption((opt) =>
          opt
            .setName('개수')
            .setDescription('삭제할 메시지 수 (1-100)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(100)
        )
        .addChannelOption((opt) =>
          opt
            .setName('채널')
            .setDescription('대상 채널 (기본: 현재 채널)')
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('전체')
        .setDescription('채널의 모든 메시지를 삭제합니다 (14일 이내)')
        .addChannelOption((opt) =>
          opt
            .setName('채널')
            .setDescription('대상 채널 (기본: 현재 채널)')
            .addChannelTypes(ChannelType.GuildText)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const channel = interaction.options.getChannel('채널') || interaction.channel;

    // 봇 권한 확인
    const botMember = interaction.guild.members.me;
    if (!channel.permissionsFor(botMember).has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({
        content: `❌ 봇이 ${channel} 채널에서 메시지를 삭제할 권한이 없습니다.`,
        ephemeral: true,
      });
    }

    if (sub === '개수') {
      return this.purgeCount(interaction, channel);
    }
    if (sub === '전체') {
      return this.purgeAll(interaction, channel);
    }
  },

  async purgeCount(interaction, channel) {
    const count = interaction.options.getInteger('개수');
    await interaction.deferReply({ ephemeral: true });

    try {
      const deleted = await channel.bulkDelete(count, true);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🧹 청소 완료')
            .setDescription(`${channel}에서 **${deleted.size}개** 메시지를 삭제했습니다.`)
            .setColor(0x57f287)
            .setFooter({ text: '14일 이상 지난 메시지는 삭제되지 않습니다' })
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('청소 오류:', err);
      await interaction.editReply({
        content: `❌ 삭제 실패: ${err.message}`,
      });
    }
  },

  async purgeAll(interaction, channel) {
    await interaction.deferReply({ ephemeral: true });

    try {
      let totalDeleted = 0;
      let rounds = 0;
      const maxRounds = 20; // 안전장치 (최대 2000개)

      while (rounds < maxRounds) {
        const deleted = await channel.bulkDelete(100, true);
        totalDeleted += deleted.size;
        rounds++;

        if (deleted.size < 100) break; // 더 이상 삭제할 것 없음
      }

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🧹 전체 청소 완료')
            .setDescription(
              `${channel}에서 **${totalDeleted}개** 메시지를 삭제했습니다.\n` +
                (rounds >= maxRounds ? '\n⚠️ 최대 삭제량(2000개)에 도달했습니다. 남은 메시지가 있다면 다시 실행하세요.' : '')
            )
            .setColor(0x57f287)
            .setFooter({ text: '14일 이상 지난 메시지는 삭제되지 않습니다' })
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('전체 청소 오류:', err);
      await interaction.editReply({
        content: `❌ 삭제 실패: ${err.message}`,
      });
    }
  },
};
