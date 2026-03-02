const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');
const { valorant } = require('../services/unifiedPatchScheduler');
const { forceGetLatestPatch, loadLastPatch } = valorant;
const { sendPatchToChannel, setPatchChannel, removePatchChannel, getPatchChannel } = valorant;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('발로란트패치노트')
    .setDescription('발로란트(VALORANT) 패치노트 관련 명령어')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('최신')
        .setDescription('최신 발로란트 패치노트를 AI로 요약해서 보여줍니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('설정')
        .setDescription('발로란트 패치노트 자동 알림 채널을 설정합니다')
        .addChannelOption((opt) =>
          opt
            .setName('채널')
            .setDescription('발로란트 패치노트를 받을 채널')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('해제')
        .setDescription('발로란트 패치노트 자동 알림을 해제합니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('상태')
        .setDescription('발로란트 패치노트 알림 상태를 확인합니다')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case '최신': return this.getLatest(interaction);
      case '설정': return this.setChannel(interaction);
      case '해제': return this.removeChannel(interaction);
      case '상태': return this.getStatus(interaction);
    }
  },

  async getLatest(interaction) {
    await interaction.deferReply();

    try {
      const loadingEmbed = new EmbedBuilder()
        .setTitle('🔍 최신 발로란트 패치노트 가져오는 중...')
        .setDescription('패치노트를 크롤링하고 AI가 요약하고 있습니다.\n잠시만 기다려주세요... (약 10~30초)')
        .setColor(0xff4655);

      await interaction.editReply({ embeds: [loadingEmbed] });

      const patchData = await forceGetLatestPatch();

      if (!patchData) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ 발로란트 패치노트를 가져올 수 없습니다')
              .setDescription('발로란트 패치노트 페이지에 접근할 수 없습니다.\n잠시 후 다시 시도해주세요.')
              .setColor(0xff0000),
          ],
        });
      }

      await interaction.editReply({
        content: '✅ 발로란트 패치노트 요약이 완료되었습니다!',
        embeds: [],
      });

      await sendPatchToChannel(interaction.channel, patchData);
    } catch (err) {
      console.error('발로란트 패치노트 명령어 오류:', err);
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ 오류 발생')
            .setDescription(`발로란트 패치노트를 가져오는 중 오류가 발생했습니다.\n${err.message}`)
            .setColor(0xff0000),
        ],
      });
    }
  },

  async setChannel(interaction) {
    const channel = interaction.options.getChannel('채널');
    setPatchChannel(interaction.guild.id, channel.id);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ 발로란트 패치노트 알림 채널 설정 완료')
          .setDescription(
            `${channel} 채널에 발로란트 패치노트 알림이 전송됩니다.\n\n` +
            '새로운 발로란트 패치가 나오면 이 채널에 자동으로 알림이 옵니다!\n' +
            '해제하려면 `/발로란트패치노트 해제`를 사용하세요.'
          )
          .setColor(0x00ff00),
      ],
      ephemeral: true,
    });
  },

  async removeChannel(interaction) {
    const channelId = getPatchChannel(interaction.guild.id);

    if (!channelId) {
      return interaction.reply({
        content: '❌ 이 서버에 발로란트 패치노트 알림이 설정되어 있지 않습니다.',
        ephemeral: true,
      });
    }

    removePatchChannel(interaction.guild.id);
    await interaction.reply({
      content: '✅ 발로란트 패치노트 자동 알림이 해제되었습니다.',
      ephemeral: true,
    });
  },

  async getStatus(interaction) {
    const lastPatch = loadLastPatch();
    const channelId = getPatchChannel(interaction.guild.id);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📊 발로란트 패치노트 알림 상태')
          .addFields(
            {
              name: '📢 알림 채널',
              value: channelId ? `<#${channelId}>` : '❌ 설정되지 않음',
              inline: true,
            },
            {
              name: '🤖 AI 요약',
              value: process.env.ANTHROPIC_API_KEY ? '✅ 활성화' : '❌ API 키 없음',
              inline: true,
            },
            {
              name: '⏰ 자동 체크',
              value: channelId ? '✅ 30분 간격' : '❌ 비활성화',
              inline: true,
            },
            {
              name: '🔫 마지막 발로란트 패치',
              value: lastPatch.lastTitle || '기록 없음',
            },
            {
              name: '🔗 마지막 패치 URL',
              value: lastPatch.lastUrl || '없음',
            },
            {
              name: '🕐 마지막 체크',
              value: lastPatch.checkedAt
                ? new Date(lastPatch.checkedAt).toLocaleString('ko-KR')
                : '없음',
            }
          )
          .setColor(0xff4655)
          .setTimestamp(),
      ],
      ephemeral: true,
    });
  },
};
