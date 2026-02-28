const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');
const {
  setLckChannel,
  removeLckChannel,
  getLckChannel,
  searchChzzkChannel,
  getLiveDetail,
} = require('../services/chzzkService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lck알림')
    .setDescription('치지직(Chzzk) LCK 경기 시작 알림 관련 명령어')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('설정')
        .setDescription('LCK 알림을 받을 Discord 채널과 치지직 채널 ID를 설정합니다')
        .addChannelOption((opt) =>
          opt
            .setName('알림채널')
            .setDescription('LCK 경기 시작 알림을 받을 Discord 채널')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
        .addStringOption((opt) =>
          opt
            .setName('치지직채널id')
            .setDescription('모니터링할 치지직 채널 ID (예: 6de30a64ffd940a23eca8a3eded2b60b)')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('해제')
        .setDescription('LCK 경기 시작 알림을 해제합니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('상태')
        .setDescription('LCK 알림 설정 상태 및 현재 방송 여부를 확인합니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('검색')
        .setDescription('치지직에서 채널을 검색합니다 (채널 ID 확인용)')
        .addStringOption((opt) =>
          opt
            .setName('검색어')
            .setDescription('검색할 채널 이름 (예: LCK, T1, 한화생명)')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case '설정': return this.setup(interaction);
      case '해제': return this.remove(interaction);
      case '상태': return this.status(interaction);
      case '검색': return this.search(interaction);
    }
  },

  // ============================================
  // ⚙️ LCK 알림 설정
  // ============================================
  async setup(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const discordChannel = interaction.options.getChannel('알림채널');
    let chzzkChannelId = interaction.options.getString('치지직채널id').trim();

    // URL에서 채널 ID만 추출 (https://chzzk.naver.com/live/XXXX 형태 처리)
    const urlMatch = chzzkChannelId.match(/chzzk\.naver\.com\/(?:live\/)?([a-f0-9]+)/i);
    if (urlMatch) {
      chzzkChannelId = urlMatch[1];
    }

    // 채널 유효성 검사
    const liveData = await getLiveDetail(chzzkChannelId);
    let channelName = chzzkChannelId;

    if (liveData) {
      channelName = liveData.channelName || chzzkChannelId;
    } else {
      // 채널 자체 정보 검색으로 이름 확인 시도
      const searchResults = await searchChzzkChannel(chzzkChannelId.substring(0, 8));
      const found = searchResults.find((ch) => ch.channelId === chzzkChannelId);
      if (found) channelName = found.channelName;
    }

    setLckChannel(interaction.guild.id, discordChannel.id, chzzkChannelId, channelName);

    const isLive = liveData?.status === 'OPEN';

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ LCK 알림 설정 완료')
          .setDescription(
            `${discordChannel} 채널에서 LCK 경기 시작 알림을 받습니다.\n\n` +
            `치지직 채널: **${channelName}**\n` +
            `채널 ID: \`${chzzkChannelId}\`\n` +
            `현재 방송 상태: ${isLive ? '🔴 라이브 중' : '⚫ 방송 없음'}\n\n` +
            '경기가 시작되면 자동으로 알림이 전송됩니다!'
          )
          .setColor(0x003087)
          .setTimestamp(),
      ],
    });
  },

  // ============================================
  // 🔇 LCK 알림 해제
  // ============================================
  async remove(interaction) {
    const config = getLckChannel(interaction.guild.id);

    if (!config) {
      return interaction.reply({
        content: '❌ 이 서버에 LCK 알림이 설정되어 있지 않습니다.',
        ephemeral: true,
      });
    }

    removeLckChannel(interaction.guild.id);
    await interaction.reply({
      content: '✅ LCK 경기 시작 알림이 해제되었습니다.',
      ephemeral: true,
    });
  },

  // ============================================
  // 📊 LCK 알림 상태
  // ============================================
  async status(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const config = getLckChannel(interaction.guild.id);

    if (!config) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('📊 LCK 알림 상태')
            .setDescription('❌ LCK 알림이 설정되지 않았습니다.\n`/lck알림 설정` 명령어로 설정하세요.')
            .setColor(0x5865f2),
        ],
      });
    }

    let liveStatus = '⚫ 확인 중...';
    let liveTitle = '';

    try {
      const liveData = await getLiveDetail(config.chzzkChannelId);
      if (liveData) {
        if (liveData.status === 'OPEN') {
          liveStatus = `🔴 라이브 중 (${liveData.concurrentUserCount.toLocaleString('ko-KR')}명 시청)`;
          liveTitle = liveData.liveTitle || '';
        } else {
          liveStatus = '⚫ 방송 없음';
        }
      } else {
        liveStatus = '❓ 채널 정보 없음';
      }
    } catch {
      liveStatus = '⚠️ 확인 실패';
    }

    const fields = [
      {
        name: '📢 알림 채널',
        value: `<#${config.discordChannelId}>`,
        inline: true,
      },
      {
        name: '📺 치지직 채널',
        value: config.chzzkChannelName || config.chzzkChannelId,
        inline: true,
      },
      {
        name: '🔴 현재 방송 상태',
        value: liveStatus,
        inline: false,
      },
      {
        name: '⏰ 체크 간격',
        value: '5분마다 자동 확인',
        inline: true,
      },
      {
        name: '📅 설정 일시',
        value: config.setAt
          ? new Date(config.setAt).toLocaleString('ko-KR')
          : '알 수 없음',
        inline: true,
      },
    ];

    if (liveTitle) {
      fields.push({ name: '🎬 현재 방송 제목', value: liveTitle });
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📊 LCK 알림 상태')
          .addFields(fields)
          .setColor(0x003087)
          .setTimestamp(),
      ],
    });
  },

  // ============================================
  // 🔍 치지직 채널 검색
  // ============================================
  async search(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const keyword = interaction.options.getString('검색어');

    const results = await searchChzzkChannel(keyword);

    if (!results || results.length === 0) {
      return interaction.editReply({
        content: `❌ "${keyword}"에 대한 치지직 채널 검색 결과가 없습니다.`,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`🔍 치지직 채널 검색 결과: "${keyword}"`)
      .setDescription('채널 ID를 복사해서 `/lck알림 설정` 명령어에 사용하세요.')
      .setColor(0x03c75a); // 치지직 그린 색상

    const topResults = results.slice(0, 5);
    for (const ch of topResults) {
      embed.addFields({
        name: `${ch.isLive ? '🔴' : '⚫'} ${ch.channelName}`,
        value: `채널 ID: \`${ch.channelId}\`\n팔로워: ${ch.followerCount.toLocaleString('ko-KR')}명`,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
