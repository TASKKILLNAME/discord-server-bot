const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const {
  createEvent,
  toggleParticipant,
  setRsvp,
  deleteEvent,
  getGuildEvents,
  getEvent,
  createEventEmbed,
} = require('../services/eventService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('이벤트')
    .setDescription('이벤트/일정 관리 명령어')
    .addSubcommand((sub) =>
      sub
        .setName('생성')
        .setDescription('새 이벤트를 생성합니다')
        .addStringOption((opt) =>
          opt.setName('제목').setDescription('이벤트 제목').setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('날짜')
            .setDescription('날짜 (예: 2026-05-01)')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('시간')
            .setDescription('시간 (예: 20:00)')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('장소').setDescription('이벤트 장소 (예: 성균관대역)')
        )
        .addStringOption((opt) =>
          opt.setName('주최자').setDescription('주최자 이름 (없으면 본인)')
        )
        .addStringOption((opt) =>
          opt.setName('설명').setDescription('이벤트 설명')
        )
        .addStringOption((opt) =>
          opt
            .setName('마감')
            .setDescription('투표 마감 (예: 2026-04-30 23:59) - 지나면 참석/불참 변경 불가')
        )
        .addChannelOption((opt) =>
          opt
            .setName('채널')
            .setDescription('이벤트를 게시할 채널 (기본: 현재 채널)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .addBooleanOption((opt) =>
          opt
            .setName('전체알림')
            .setDescription('@everyone으로 전체 멤버 알림 (기본 false)')
        )
        .addStringOption((opt) =>
          opt
            .setName('반복')
            .setDescription('반복 설정')
            .addChoices(
              { name: '반복 없음', value: 'none' },
              { name: '🔁 매일 반복', value: 'daily' },
              { name: '🔁 매주 반복', value: 'weekly' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub.setName('목록').setDescription('예정된 이벤트 목록을 보여줍니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('삭제')
        .setDescription('이벤트를 삭제합니다')
        .addStringOption((opt) =>
          opt
            .setName('이벤트id')
            .setDescription('삭제할 이벤트 ID')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('정보')
        .setDescription('이벤트 상세 정보를 봅니다')
        .addStringOption((opt) =>
          opt
            .setName('이벤트id')
            .setDescription('이벤트 ID')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case '생성':
        return this.create(interaction);
      case '목록':
        return this.list(interaction);
      case '삭제':
        return this.remove(interaction);
      case '정보':
        return this.info(interaction);
    }
  },

  // ============================================
  // 이벤트 생성
  // ============================================
  async create(interaction) {
    const title = interaction.options.getString('제목');
    const dateStr = interaction.options.getString('날짜');
    const timeStr = interaction.options.getString('시간');
    const location = interaction.options.getString('장소') || '';
    const organizer = interaction.options.getString('주최자') || '';
    const description = interaction.options.getString('설명') || '';
    const deadlineStr = interaction.options.getString('마감') || '';
    const targetChannel =
      interaction.options.getChannel('채널') || interaction.channel;
    const mentionEveryone = interaction.options.getBoolean('전체알림') || false;
    const repeat = interaction.options.getString('반복') || 'none';

    // 날짜 파싱
    const datetime = new Date(`${dateStr}T${timeStr}:00+09:00`); // KST

    if (isNaN(datetime.getTime())) {
      return interaction.reply({
        content: '❌ 날짜/시간 형식이 올바르지 않습니다.\n예: 날짜 `2026-05-01` 시간 `20:00`',
        ephemeral: true,
      });
    }

    if (datetime < new Date()) {
      return interaction.reply({
        content: '❌ 과거 시간으로는 이벤트를 생성할 수 없습니다.',
        ephemeral: true,
      });
    }

    // 마감 시간 파싱 (선택)
    let deadlineISO = null;
    if (deadlineStr.trim()) {
      const normalized = deadlineStr.trim().replace(' ', 'T');
      const deadlineDate = new Date(`${normalized}:00+09:00`);
      if (isNaN(deadlineDate.getTime())) {
        return interaction.reply({
          content: '❌ 마감 시간 형식이 올바르지 않습니다.\n예: `2026-04-30 23:59`',
          ephemeral: true,
        });
      }
      if (deadlineDate >= datetime) {
        return interaction.reply({
          content: '❌ 마감 시간은 이벤트 시작 시간보다 이전이어야 합니다.',
          ephemeral: true,
        });
      }
      deadlineISO = deadlineDate.toISOString();
    }

    // 채널에 보내기 권한 체크
    const me = interaction.guild.members.me;
    const perms = targetChannel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.SendMessages)) {
      return interaction.reply({
        content: `❌ ${targetChannel} 채널에 메시지를 보낼 권한이 없습니다.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: targetChannel.id !== interaction.channel.id });

    // 이벤트 생성 (messageId는 나중에 업데이트)
    const event = createEvent({
      guildId: interaction.guild.id,
      channelId: targetChannel.id,
      messageId: null,
      creatorId: interaction.user.id,
      creatorName: interaction.member.displayName,
      organizer: organizer || interaction.member.displayName,
      location,
      deadline: deadlineISO,
      title,
      description,
      datetime: datetime.toISOString(),
      repeat,
    });

    const embed = createEventEmbed(event);
    const row = createEventButtons(event.id);

    // 다른 채널이면 그 채널에 보내고, 같은 채널이면 deferReply의 답으로 처리
    let postedMessage;
    if (targetChannel.id !== interaction.channel.id) {
      postedMessage = await targetChannel.send({
        content: mentionEveryone ? '@everyone' : undefined,
        embeds: [embed],
        components: [row],
        allowedMentions: mentionEveryone ? { parse: ['everyone'] } : { parse: [] },
      });
      await interaction.editReply({
        content: `✅ ${targetChannel}에 이벤트를 게시했어요.`,
      });
    } else {
      postedMessage = await interaction.editReply({
        content: mentionEveryone ? '@everyone' : undefined,
        embeds: [embed],
        components: [row],
        allowedMentions: mentionEveryone ? { parse: ['everyone'] } : { parse: [] },
      });
    }

    // messageId 업데이트
    const events = require('../services/eventService').loadEvents();
    if (events[event.id]) {
      events[event.id].messageId = postedMessage.id;
      require('fs').writeFileSync(
        require('path').join(__dirname, '../../data/events.json'),
        JSON.stringify(events, null, 2)
      );
    }
  },

  // ============================================
  // 이벤트 목록
  // ============================================
  async list(interaction) {
    const events = getGuildEvents(interaction.guild.id);
    const now = new Date();
    const upcoming = events.filter((e) => new Date(e.datetime) > now);

    if (upcoming.length === 0) {
      return interaction.reply({
        content: '📅 예정된 이벤트가 없습니다.\n`/이벤트 생성`으로 새 이벤트를 만들어보세요!',
        ephemeral: true,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('📅 예정된 이벤트')
      .setColor(0x5865f2)
      .setDescription(
        upcoming
          .slice(0, 10)
          .map((e, i) => {
            const ts = Math.floor(new Date(e.datetime).getTime() / 1000);
            const repeatIcon = e.repeat !== 'none' ? ' 🔁' : '';
            return `**${i + 1}. ${e.title}${repeatIcon}**\n┗ <t:${ts}:F> (<t:${ts}:R>) | 참가자 ${e.participants.length}명\n┗ ID: \`${e.id}\``;
          })
          .join('\n\n')
      )
      .setFooter({ text: `총 ${upcoming.length}개의 예정된 이벤트` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  // ============================================
  // 이벤트 삭제
  // ============================================
  async remove(interaction) {
    const eventId = interaction.options.getString('이벤트id');
    const event = getEvent(eventId);

    if (!event) {
      return interaction.reply({
        content: '❌ 이벤트를 찾을 수 없습니다.',
        ephemeral: true,
      });
    }

    // 생성자 또는 관리자만 삭제 가능
    if (
      event.creatorId !== interaction.user.id &&
      !interaction.memberPermissions.has(PermissionFlagsBits.ManageEvents)
    ) {
      return interaction.reply({
        content: '❌ 이벤트 생성자 또는 관리자만 삭제할 수 있습니다.',
        ephemeral: true,
      });
    }

    // 참가자들에게 취소 DM 전송
    for (const participant of event.participants) {
      try {
        const user = await interaction.client.users.fetch(participant.id);
        if (user) {
          const cancelEmbed = new EmbedBuilder()
            .setTitle('❌ 이벤트 취소됨')
            .setDescription(`**${event.title}** 이벤트가 취소되었습니다.`)
            .setColor(0xf04747)
            .setTimestamp();
          await user.send({ embeds: [cancelEmbed] }).catch(() => {});
        }
      } catch (err) {
        // DM 전송 실패 무시
      }
    }

    deleteEvent(eventId);

    await interaction.reply({
      content: `✅ **${event.title}** 이벤트가 삭제되었습니다. 참가자들에게 취소 알림을 보냈습니다.`,
      ephemeral: true,
    });
  },

  // ============================================
  // 이벤트 정보
  // ============================================
  async info(interaction) {
    const eventId = interaction.options.getString('이벤트id');
    const event = getEvent(eventId);

    if (!event) {
      return interaction.reply({
        content: '❌ 이벤트를 찾을 수 없습니다.',
        ephemeral: true,
      });
    }

    const embed = createEventEmbed(event);
    const row = createEventButtons(event.id);

    await interaction.reply({
      embeds: [embed],
      components: [row],
    });
  },

  // ============================================
  // 버튼 처리 (참석/불참, 명단)
  // ============================================
  async handleButton(interaction) {
    // customId 형식: event_<action>_evt_<timestamp>
    const action = interaction.customId.split('_')[1];
    const fullEventId = `evt_${interaction.customId.split('evt_')[1]}`;

    if (action === 'attend') {
      return this.handleRsvp(interaction, fullEventId, 'attend');
    }
    if (action === 'decline') {
      return this.handleRsvp(interaction, fullEventId, 'decline');
    }
    if (action === 'list') {
      return this.handleParticipantList(interaction, fullEventId);
    }
    // 옛 버전 호환
    if (action === 'join') {
      return this.handleRsvp(interaction, fullEventId, 'attend');
    }
  },

  async handleRsvp(interaction, eventId, status) {
    const result = setRsvp(
      eventId,
      interaction.user.id,
      interaction.member.displayName,
      status
    );

    if (!result) {
      return interaction.reply({
        content: '❌ 이벤트를 찾을 수 없습니다.',
        ephemeral: true,
      });
    }

    if (result.closed) {
      return interaction.reply({
        content: '🔒 투표가 마감됐어요.',
        ephemeral: true,
      });
    }

    // Embed 업데이트
    const embed = createEventEmbed(result.event);
    const row = createEventButtons(eventId);

    await interaction.update({
      embeds: [embed],
      components: [row],
    });

    // 확인 메시지
    let msg;
    if (result.status === 'attend') {
      msg = `✅ **${result.event.title}** 참석으로 표시했어요. 시작 5분 전 DM 알림이 가요.`;
    } else if (result.status === 'decline') {
      msg = `❌ **${result.event.title}** 불참으로 표시했어요.`;
    } else {
      msg = `↩️ **${result.event.title}** 응답을 취소했어요.`;
    }

    await interaction.followUp({ content: msg, ephemeral: true });
  },

  async handleParticipantList(interaction, eventId) {
    const event = getEvent(eventId);

    if (!event) {
      return interaction.reply({
        content: '❌ 이벤트를 찾을 수 없습니다.',
        ephemeral: true,
      });
    }

    const fmtList = (arr) =>
      arr.length > 0
        ? arr.map((p, i) => `${i + 1}. <@${p.id}>`).join('\n')
        : '*없음*';

    const embed = new EmbedBuilder()
      .setTitle(`📋 ${event.title} - 응답 명단`)
      .setColor(0x43b581)
      .addFields(
        { name: `✅ 참석 (${event.attendees.length}명)`, value: fmtList(event.attendees), inline: true },
        { name: `❌ 불참 (${event.decliners.length}명)`, value: fmtList(event.decliners), inline: true }
      )
      .setFooter({
        text: `총 ${event.attendees.length + event.decliners.length}명 응답`,
      });

    await interaction.reply({
      embeds: [embed],
      ephemeral: true,
    });
  },
};

// ============================================
// 버튼 생성 헬퍼
// ============================================
function createEventButtons(eventId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`event_attend_${eventId}`)
      .setLabel('✅ 참석')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`event_decline_${eventId}`)
      .setLabel('❌ 불참')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`event_list_${eventId}`)
      .setLabel('📋 명단 보기')
      .setStyle(ButtonStyle.Secondary)
  );
}