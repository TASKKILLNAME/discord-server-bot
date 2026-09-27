const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  escapeMarkdown,
} = require('discord.js');
const { fetchRecentMatchData } = require('../services/riotService');
const {
  BriefingError,
  createLiveBriefing,
  tryAcquireCooldown: tryAcquireBriefingCooldown,
  describeErrorForLog: describeBriefingError,
} = require('../services/liveBriefingService');
const { buildLiveGameView } = require('../services/liveGameView');
const { renderLiveGameCard } = require('../services/liveGameCard');
const { renderLiveGameMessage, renderLoading, renderError } = require('../services/liveGameLayout');
const {
  analyzeRecentMatches,
  parseAnalysisToFields,
} = require('../services/lolAnalyzer');
const {
  registerPlayer,
  unregisterPlayer,
  setTrackerChannel,
  getRegisteredPlayers,
  getPlayer,
  getTrackerChannel,
  ensureTrackerRole,
  setChannelPermissions,
  addTrackerRole,
  removeTrackerRole,
} = require('../services/lolTrackerService');
const {
  buildRecentMatchLayout,
  buildSingleMatchLayout,
} = require('../services/matchLayoutService');
const {
  USAGE_TEXT: PREDICTION_USAGE_TEXT,
  PredictionError,
  predictForTarget,
  tryAcquireCooldown,
  isRiotApiConfigured,
  parsePredictionOptions,
  classifyPredictionError,
  describeErrorForLog,
  buildPredictionEmbed,
} = require('../services/lolPredictionService');

const NO_MENTIONS = { parse: [] };

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
    )
    .addSubcommand((sub) =>
      sub
        .setName('승부예측')
        .setDescription('최근 솔랭 전적 기반 다음 판 승패 참고 추정 (AI 미사용)')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('이 서버에 등록된 멤버 (미입력 시 본인)')
        )
        .addStringOption((opt) =>
          opt.setName('소환사명').setDescription('직접 입력할 게임 이름 (태그와 함께 입력)').setMaxLength(32)
        )
        .addStringOption((opt) =>
          opt.setName('태그').setDescription('직접 입력할 태그라인 (예: KR1)').setMaxLength(10)
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
      case '승부예측':
        return this.predict(interaction);
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
  // 조회 시점의 진행 중 경기 + 참가자별 랭크·주챔·최근 전적·첩자 판정률을 라인별로 맞대 보여준다.
  async liveGame(interaction) {
    const gameName = interaction.options.getString('소환사명');
    const tagLine = interaction.options.getString('태그');

    const waitMs = tryAcquireBriefingCooldown(interaction.guildId || 'dm', interaction.user.id);
    if (waitMs > 0) {
      return interaction.reply({ content: `⏳ ${Math.ceil(waitMs / 1000)}초 후에 다시 시도해주세요.`, ephemeral: true });
    }

    await interaction.deferReply();

    try {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🔍 현재 게임을 찾는 중...')
            .setDescription(`**${escapeMarkdown(`${gameName}#${tagLine}`)}** 소환사의 진행 중인 게임을 조회합니다.`)
            .setColor(0xffa500),
        ],
        allowedMentions: NO_MENTIONS,
      });

      const model = await createLiveBriefing(
        { gameName, tagLine },
        {
          onBasic: (basic) => interaction.editReply(renderLoading(buildLiveGameView(basic))),
        }
      );

      // 게임 중이 아니면 → 최근 1게임으로 대체
      if (model.notInGame) {
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

        const layout = buildSingleMatchLayout(matchData, fields, gameName, tagLine);
        return interaction.editReply({ components: layout.components, flags: layout.flags, embeds: [] });
      }

      const view = buildLiveGameView(model);
      // 카드 이미지는 실패하거나 늦으면 텍스트만 보낸다
      let image = null;
      try {
        image = await renderLiveGameCard(view);
      } catch (err) {
        console.error(`실시간 카드 이미지 생성 실패: ${err.message}`);
      }
      await interaction.editReply(renderLiveGameMessage(view, { image }));
    } catch (err) {
      console.error(`실시간 조회 오류: ${describeBriefingError(err)}`);
      const message = err instanceof BriefingError
        ? err.userMessage
        : err.userMessage || '실시간 게임 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
      await interaction
        .editReply(renderError(message))
        .catch((editErr) => console.error(`실시간 조회 응답 실패: ${editErr.message}`));
    }
  },

  // ============================================
  // 📊 최근 전적 조회 (수동)
  // ============================================
  async recentMatches(interaction) {
    const gameName = interaction.options.getString('소환사명');
    const tagLine = interaction.options.getString('태그');
    const count = interaction.options.getInteger('횟수') || 5;

    await interaction.deferReply();

    try {
      const loadingEmbed = new EmbedBuilder()
        .setTitle('🔍 최근 전적을 가져오는 중...')
        .setDescription(
          `**${gameName}#${tagLine}** 최근 ${count}게임을 분석 중입니다.\n잠시만 기다려주세요... (약 15~40초)`
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

  // ============================================
  // 🔮 다음 솔랭 승부 예측 (LLM 미사용)
  // ============================================
  async predict(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ content: '❌ 서버 안에서만 사용할 수 있습니다.', ephemeral: true });
    }

    const parsed = parsePredictionOptions({
      member: interaction.options.getUser('멤버'),
      gameName: interaction.options.getString('소환사명'),
      tagLine: interaction.options.getString('태그'),
    });
    if (parsed.error) {
      return interaction.reply({
        content: `❌ ${parsed.error}\n\n${PREDICTION_USAGE_TEXT}`,
        ephemeral: true,
        allowedMentions: NO_MENTIONS,
      });
    }

    if (!isRiotApiConfigured()) {
      return interaction.reply({ content: `❌ ${new PredictionError('NO_API_KEY').userMessage}`, ephemeral: true });
    }

    const waitMs = tryAcquireCooldown(interaction.guild.id, interaction.user.id);
    if (waitMs > 0) {
      return interaction.reply({
        content: `⏳ ${Math.ceil(waitMs / 1000)}초 후에 다시 시도해주세요.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      let target;
      if (parsed.mode === 'direct') {
        target = { gameName: parsed.gameName, tagLine: parsed.tagLine };
      } else {
        const userId = parsed.mode === 'member' ? parsed.member.id : interaction.user.id;
        const player = await getPlayer(interaction.guild.id, userId);
        if (!player) {
          const who = parsed.mode === 'member' ? `<@${userId}>님은` : '회원님은';
          return interaction.editReply({
            content: `❌ ${who} 이 서버에 등록된 롤 계정이 없습니다. \`/전적 등록\`으로 먼저 등록해주세요.`,
            allowedMentions: NO_MENTIONS,
          });
        }
        target = { puuid: player.puuid, gameName: player.gameName, tagLine: player.tagLine };
      }

      const result = await predictForTarget(target);
      await interaction.editReply({ embeds: [buildPredictionEmbed(result)], allowedMentions: NO_MENTIONS });
    } catch (err) {
      console.error(`승부예측 오류: ${describeErrorForLog(err)}`);
      const { message } = classifyPredictionError(err);
      await interaction
        .editReply({ content: `❌ ${message}`, embeds: [], allowedMentions: NO_MENTIONS })
        .catch((editErr) => console.error(`승부예측 응답 실패: ${editErr.message}`));
    }
  },
};
