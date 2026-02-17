const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');
const { forceGetLatestPatch, loadLastPatch } = require('../services/patchCrawler');
const { sendPatchToChannel } = require('../services/patchScheduler');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('패치노트')
    .setDescription('롤 패치노트 관련 명령어')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('최신')
        .setDescription('최신 롤 패치노트를 AI로 요약해서 보여줍니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('설정')
        .setDescription('패치노트 자동 알림 채널을 설정합니다')
        .addChannelOption((opt) =>
          opt
            .setName('채널')
            .setDescription('패치노트를 받을 채널')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('상태')
        .setDescription('패치노트 알림 상태를 확인합니다')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case '최신':
        return this.getLatest(interaction);
      case '설정':
        return this.setChannel(interaction);
      case '상태':
        return this.getStatus(interaction);
    }
  },

  async getLatest(interaction) {
    await interaction.deferReply();

    try {
      const loadingEmbed = new EmbedBuilder()
        .setTitle('🔍 최신 패치노트 가져오는 중...')
        .setDescription('패치노트를 크롤링하고 AI가 요약하고 있습니다.\n잠시만 기다려주세요... (약 10~30초)')
        .setColor(0xffa500);

      await interaction.editReply({ embeds: [loadingEmbed] });

      const patchData = await forceGetLatestPatch();

      if (!patchData) {
        const errorEmbed = new EmbedBuilder()
          .setTitle('❌ 패치노트를 가져올 수 없습니다')
          .setDescription(
            '라이엇 패치노트 페이지에 접근할 수 없거나, 패치노트를 찾을 수 없습니다.\n잠시 후 다시 시도해주세요.'
          )
          .setColor(0xff0000);

        return interaction.editReply({ embeds: [errorEmbed] });
      }

      // 기존 메시지 수정으로 로딩 메시지 제거
      await interaction.editReply({
        content: '✅ 패치노트 요약이 완료되었습니다!',
        embeds: [],
      });

      // 패치노트를 현재 채널에 전송
      await sendPatchToChannel(interaction.channel, patchData);
    } catch (err) {
      console.error('패치노트 명령어 오류:', err);

      const errorEmbed = new EmbedBuilder()
        .setTitle('❌ 오류 발생')
        .setDescription(`패치노트를 가져오는 중 오류가 발생했습니다.\n${err.message}`)
        .setColor(0xff0000);

      await interaction.editReply({ embeds: [errorEmbed] });
    }
  },

  async setChannel(interaction) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: '❌ 서버 관리 권한이 필요합니다.',
        ephemeral: true,
      });
    }

    const channel = interaction.options.getChannel('채널');

    // 참고: 실제 운영에서는 DB에 저장하는 게 좋지만,
    // 여기서는 환경변수 안내 + 메모리에 저장
    process.env.LOL_PATCH_CHANNEL_ID = channel.id;

    const embed = new EmbedBuilder()
      .setTitle('✅ 패치노트 알림 채널 설정 완료')
      .setDescription(
        `${channel} 채널에 롤 패치노트 알림이 전송됩니다.\n\n` +
          '⚠️ **영구 설정하려면** `.env` 파일에 아래를 추가하세요:\n' +
          `\`LOL_PATCH_CHANNEL_ID=${channel.id}\``
      )
      .setColor(0x00ff00);

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  async getStatus(interaction) {
    const lastPatch = loadLastPatch();
    const channelId = process.env.LOL_PATCH_CHANNEL_ID;

    const embed = new EmbedBuilder()
      .setTitle('📊 패치노트 알림 상태')
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
          name: '📰 마지막 패치',
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
      .setColor(0x5865f2)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};