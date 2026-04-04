const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const {
  fetchLiveGameData,
  fetchRecentMatchData,
} = require('../services/riotService');
const {
  analyzeLiveGame,
  analyzeRecentMatches,
  parseAnalysisToFields,
} = require('../services/lolAnalyzer');
const {
  registerPlayer,
  unregisterPlayer,
  setTrackerChannel,
  getRegisteredPlayers,
  getTrackerChannel,
  ensureTrackerRole,
  setChannelPermissions,
  addTrackerRole,
  removeTrackerRole,
} = require('../services/lolTrackerService');
const { hasCredit, useCredit, getCredits } = require('../services/membershipService');
const {
  buildRecentMatchLayout,
  buildLiveGameLayout,
  buildSingleMatchLayout,
} = require('../services/matchLayoutService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('전적')
    .setDescription('롤 전적 검색, AI 분석, 자동 게임 감지')
    .addSubcommand((sub) =>
      sub
        .setName('등록')
        .setDescription('롤 계정을 등록합니다 (게임 자동 감지)')
        .addStringOption((opt) =>
          opt.setName('소환사명').setDescription('게임 이름 (예: Hide on bush)').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('태그').setDescription('태그라인 (예: KR1)').setRequired(true)
        )
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('등록할 멤버 (미입력 시 본인)')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('해제')
        .setDescription('롤 계정 등록을 해제합니다')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('해제할 멤버 (미입력 시 본인)')
        )
    )
    .addSubcommand((sub) =>
      sub.setName('목록').setDescription('이 서버에 등록된 소환사 목록을 확인합니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('채널설정')
        .setDescription('게임 자동 감지 알림 채널을 설정합니다')
        .addChannelOption((opt) =>
          opt
            .setName('채널')
            .setDescription('알림을 받을 채널')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('실시간')
        .setDescription('실시간 게임 정보를 AI로 분석합니다')
        .addStringOption((opt) =>
          opt.setName('소환사명').setDescription('게임 이름 (예: Hide on bush)').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('태그').setDescription('태그라인 (예: KR1)').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('최근전적')
        .setDescription('최근 전적을 AI로 분석합니다')
        .addStringOption((opt) =>
          opt.setName('소환사명').setDescription('게임 이름 (예: Hide on bush)').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('태그').setDescription('태그라인 (예: KR1)').setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('횟수')
            .setDescription('조회할 게임 수 (기본: 5)')
            .setMinValue(1)
            .setMaxValue(20)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case '등록':
        return this.register(interaction);
      case '해제':
        return this.unregister(interaction);
      case '목록':
        return this.list(interaction);
      case '채널설정':
        return this.setChannel(interaction);
      case '실시간':
        return this.liveGame(interaction);
      case '최근전적':
        return this.recentMatches(interaction);
    }
  },

  // ============================================
  // 📝 계정 등록
  // ============================================
  async register(interaction) {
    const gameName = interaction.options.getString('소환사명');
    const tagLine = interaction.options.getString('태그');
    const targetUser = interaction.options.getUser('멤버') || interaction.user;
    const isSelf = targetUser.id === interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    try {
      const account = await registerPlayer(
        interaction.guild.id,
        targetUser.id,
        gameName,
        tagLine
      );

      // 트래커 역할 자동 부여
      await addTrackerRole(interaction.guild, targetUser.id);

      const targetDisplay = isSelf ? '' : ` (<@${targetUser.id}>님의)`;
      const embed = new EmbedBuilder()
        .setTitle('✅ 롤 계정 등록 완료!')
        .setDescription(
          `${targetDisplay}**${account.gameName}#${account.tagLine}** 계정이 등록되었습니다.\n\n` +
            '🔒 전용 채널 접근 역할이 부여되었습니다.\n' +
            '게임을 시작하면 자동으로 AI 분석이 알림 채널에 전송됩니다!\n' +
            '`/전적 채널설정`으로 알림 채널을 설정해주세요.'
        )
        .setColor(0x57f287)
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply({
        content: `❌ 등록 실패: ${err.userMessage || err.message}`,
      });
    }
  },

  // ============================================
  // 🗑️ 등록 해제
  // ============================================
  async unregister(interaction) {
    const targetUser = interaction.options.getUser('멤버') || interaction.user;
    const isSelf = targetUser.id === interaction.user.id;
    const removed = await unregisterPlayer(interaction.guild.id, targetUser.id);

    if (removed) {
      // 트래커 역할 제거
      await removeTrackerRole(interaction.guild, targetUser.id);

      const msg = isSelf
        ? '✅ 롤 계정 등록이 해제되었습니다. (채널 접근 역할 제거됨)'
        : `✅ <@${targetUser.id}>님의 롤 계정 등록이 해제되었습니다. (채널 접근 역할 제거됨)`;
      await interaction.reply({ content: msg, ephemeral: true });
    } else {
      const msg = isSelf
        ? '❌ 등록된 계정이 없습니다.'
        : `❌ <@${targetUser.id}>님의 등록된 계정이 없습니다.`;
      await interaction.reply({ content: msg, ephemeral: true });
    }
  },

  // ============================================
  // 📋 등록 목록
  // ============================================
  async list(interaction) {
    const players = await getRegisteredPlayers(interaction.guild.id);
    const channelId = await getTrackerChannel(interaction.guild.id);
    const entries = Object.entries(players);

    if (entries.length === 0) {
      return interaction.reply({
        content: '📋 등록된 소환사가 없습니다. `/전적 등록`으로 계정을 등록해주세요.',
        ephemeral: true,
      });
    }

    const playerList = entries
      .map(
        ([discordId, p], i) =>
          `**${i + 1}.** <@${discordId}> → ${p.gameName}#${p.tagLine} ${p.inGame ? '🟢 게임 중' : '⚫ 오프라인'}`
      )
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle('📋 등록된 소환사 목록')
      .setDescription(playerList)
      .addFields({
        name: '📢 알림 채널',
        value: channelId ? `<#${channelId}>` : '❌ 미설정 (`/전적 채널설정`으로 설정)',
      })
      .setColor(0x5865f2)
      .setFooter({ text: `총 ${entries.length}명 등록` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  // ============================================
  // 📢 알림 채널 설정
  // ============================================
  async setChannel(interaction) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: '❌ 서버 관리 권한이 필요합니다.',
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.options.getChannel('채널');
    await setTrackerChannel(interaction.guild.id, channel.id);

    // 전용 역할 생성 + 채널 권한 설정
    const role = await ensureTrackerRole(interaction.guild);
    if (role) {
      await setChannelPermissions(channel, role);

      // 이미 등록된 멤버들에게 역할 부여
      const players = await getRegisteredPlayers(interaction.guild.id);
      for (const discordUserId of Object.keys(players)) {
        await addTrackerRole(interaction.guild, discordUserId);
      }
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ 롤 알림 채널 설정 완료')
          .setDescription(
            `${channel}에 게임 자동 감지 알림이 전송됩니다.\n\n` +
              `🔒 **\`${role?.name || '🎮 LOL 트래커'}\`** 역할이 생성되었습니다.\n` +
              '등록된 멤버만 이 채널을 볼 수 있습니다.\n' +
              '`/전적 등록` 시 역할이 자동 부여됩니다.'
          )
          .setColor(0x57f287),
      ],
    });
  },

  // ============================================
  // 🎮 실시간 게임 조회 (수동)
  // ============================================
  async liveGame(interaction) {
    const gameName = interaction.options.getString('소환사명');
    const tagLine = interaction.options.getString('태그');

    // 크레딧 보유 체크 (차감은 AI 분석 성공 후)
    if (!(await hasCredit(interaction.guild.id, interaction.user.id))) {
      const remaining = await getCredits(interaction.guild.id, interaction.user.id);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ 크레딧 부족')
            .setDescription(
              `AI 분석 크레딧이 부족합니다. (잔여: ${remaining}회)\n\n` +
                '`/멤버십 구매`로 크레딧을 충전해주세요.'
            )
            .setColor(0xff0000),
        ],
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const credits = await getCredits(interaction.guild.id, interaction.user.id);
      const loadingEmbed = new EmbedBuilder()
        .setTitle('🔍 실시간 게임 정보를 가져오는 중...')
        .setDescription(
          `**${gameName}#${tagLine}** 소환사를 검색하고 AI가 분석 중입니다.\n잠시만 기다려주세요... (약 15~40초)\n\n💳 잔여 크레딧: ${credits}회`
        )
        .setColor(0xffa500);
      await interaction.editReply({ embeds: [loadingEmbed] });

      const gameData = await fetchLiveGameData(gameName, tagLine);

      // 게임 중이 아니면 → 최근 1게임으로 대체
      if (gameData.notInGame) {
        const recentEmbed = new EmbedBuilder()
          .setTitle('💤 현재 게임 중이 아닙니다')
          .setDescription(
            `**${gameName}#${tagLine}** 소환사가 게임 중이 아닙니다.\n최근 게임을 대신 분석합니다...`
          )
          .setColor(0x808080);
        await interaction.editReply({ embeds: [recentEmbed] });

        // 최근 1게임 분석으로 대체
        const matchData = await fetchRecentMatchData(gameName, tagLine, 1);
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
        const fields = parseAnalysisToFields(analysis);

        // ✅ AI 분석 성공 → 크레딧 차감
        await useCredit(interaction.guild.id, interaction.user.id, '실시간 분석 (최근게임 대체)');

        const layout = buildSingleMatchLayout(matchData, fields, gameName, tagLine);
        return interaction.editReply({ components: layout.components, flags: layout.flags, embeds: [] });
      }

      // 실시간 게임 분석
      const analysis = await analyzeLiveGame(gameData);
      const analysisFields = parseAnalysisToFields(analysis);

      // ✅ AI 분석 성공 → 크레딧 차감
      await useCredit(interaction.guild.id, interaction.user.id, '실시간 분석');

      const layout = buildLiveGameLayout(gameData, analysisFields, gameName, tagLine);
      await interaction.editReply({ components: layout.components, flags: layout.flags, embeds: [] });
    } catch (err) {
      console.error('실시간 조회 오류:', err);
      const errorDetail = err.userMessage || err.message || '알 수 없는 오류';
      const statusCode = err.response?.status ? ` (HTTP ${err.response.status})` : '';
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ 오류 발생')
            .setDescription(`${errorDetail}${statusCode}`)
            .setColor(0xff0000),
        ],
      });
    }
  },

  // ============================================
  // 📊 최근 전적 조회 (수동)
  // ============================================
  async recentMatches(interaction) {
    const gameName = interaction.options.getString('소환사명');
    const tagLine = interaction.options.getString('태그');
    const count = interaction.options.getInteger('횟수') || 5;

    // 크레딧 보유 체크 (차감은 AI 분석 성공 후)
    if (!(await hasCredit(interaction.guild.id, interaction.user.id))) {
      const remaining = await getCredits(interaction.guild.id, interaction.user.id);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ 크레딧 부족')
            .setDescription(
              `AI 분석 크레딧이 부족합니다. (잔여: ${remaining}회)\n\n` +
                '`/멤버십 구매`로 크레딧을 충전해주세요.'
            )
            .setColor(0xff0000),
        ],
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const credits = await getCredits(interaction.guild.id, interaction.user.id);
      const loadingEmbed = new EmbedBuilder()
        .setTitle('🔍 최근 전적을 가져오는 중...')
        .setDescription(
          `**${gameName}#${tagLine}** 최근 ${count}게임을 분석 중입니다.\n잠시만 기다려주세요... (약 15~40초)\n\n💳 잔여 크레딧: ${credits}회`
        )
        .setColor(0xffa500);
      await interaction.editReply({ embeds: [loadingEmbed] });

      const matchData = await fetchRecentMatchData(gameName, tagLine, count);

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

      // AI 분석
      const analysis = await analyzeRecentMatches(matchData);
      const analysisFields = parseAnalysisToFields(analysis);

      // ✅ AI 분석 성공 → 크레딧 차감
      await useCredit(interaction.guild.id, interaction.user.id, '최근전적 분석');

      const layout = buildRecentMatchLayout(matchData, analysisFields);
      await interaction.editReply({ components: layout.components, flags: layout.flags, embeds: [] });
    } catch (err) {
      console.error('최근 전적 조회 오류:', err);
      const errorDetail = err.userMessage || err.message || '알 수 없는 오류';
      const statusCode = err.response?.status ? ` (HTTP ${err.response.status})` : '';
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ 오류 발생')
            .setDescription(`${errorDetail}${statusCode}`)
            .setColor(0xff0000),
        ],
      });
    }
  },
};
