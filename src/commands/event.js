const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const {
  createEvent,
  toggleParticipant,
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
            .setDescription('날짜 (예: 2026-02-20)')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('시간')
            .setDescription('시간 (예: 20:00)')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('설명').setDescription('이벤트 설명')
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
    const description = interaction.options.getString('설명') || '';
    const repeat = interaction.options.getString('반복') || 'none';

    // 날짜 파싱
    const datetime = new Date(`${dateStr}T${timeStr}:00+09:00`); // KST

    if (isNaN(datetime.getTime())) {
      return interaction.reply({
        content: '❌ 날짜/시간 형식이 올바르지 않습니다.\n예: 날짜 `2026-02-20` 시간 `20:00`',
        ephemeral: true,
      });
    }

    if (datetime < new Date()) {
      return interaction.reply({
        content: '❌ 과거 시간으로는 이벤트를 생성할 수 없습니다.',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    // 이벤트 생성 (messageId는 나중에 업데이트)
    const event = createEvent({
      guildId: interaction.guild.id,
      channelId: interaction.channel.id,
      messageId: null,
      creatorId: interaction.user.id,
      creatorName: interaction.member.displayName,
      title,
      description,
      datetime: datetime.toISOString(),
      repeat,
    });

    // Embed + 참가 버튼
    const embed = createEventEmbed(event);
    const row = createEventButtons(event.id);

    const reply = await interaction.editReply({
      embeds: [embed],
      components: [row],
    });

    // messageId 업데이트
    const events = require('../services/eventService').loadEvents();
    if (events[event.id]) {
      events[event.id].messageId = reply.id;
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
  // 버튼 처리 (참가/취소, 참가자 목록)
  // ============================================
  async handleButton(interaction) {
    const [action, eventId] = interaction.customId.split('_').slice(1);
    // customId format: event_join_evt_xxxxx or event_list_evt_xxxxx

    const fullEventId = `evt_${interaction.customId.split('evt_')[1]}`;

    if (action === 'join') {
      return this.handleJoin(interaction, fullEventId);
    }
    if (action === 'list') {
      return this.handleParticipantList(interaction, fullEventId);
    }
  },

  async handleJoin(interaction, eventId) {
    const event = toggleParticipant(
      eventId,
      interaction.user.id,
      interaction.member.displayName
    );

    if (!event) {
      return interaction.reply({
        content: '❌ 이벤트를 찾을 수 없습니다.',
        ephemeral: true,
      });
    }

    const isJoined = event.participants.some((p) => p.id === interaction.user.id);

    // Embed 업데이트
    const embed = createEventEmbed(event);
    const row = createEventButtons(eventId);

    await interaction.update({
      embeds: [embed],
      components: [row],
    });

    // 확인 메시지 (ephemeral follow-up)
    const confirmMsg = isJoined
      ? `✅ **${event.title}** 이벤트에 참가했습니다! 시작 5분 전에 DM으로 알림을 보내드립니다.`
      : `❎ **${event.title}** 이벤트 참가를 취소했습니다.`;

    await interaction.followUp({
      content: confirmMsg,
      ephemeral: true,
    });
  },

  async handleParticipantList(interaction, eventId) {
    const event = getEvent(eventId);

    if (!event) {
      return interaction.reply({
        content: '❌ 이벤트를 찾을 수 없습니다.',
        ephemeral: true,
      });
    }

    if (event.participants.length === 0) {
      return interaction.reply({
        content: '📋 아직 참가자가 없습니다.',
        ephemeral: true,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`📋 ${event.title} - 참가자 목록`)
      .setDescription(
        event.participants
          .map((p, i) => {
            const joinDate = new Date(p.joinedAt);
            return `${i + 1}. <@${p.id}> (${joinDate.toLocaleDateString('ko-KR')} 참가)`;
          })
          .join('\n')
      )
      .setColor(0x43b581)
      .setFooter({ text: `총 ${event.participants.length}명 참가` });

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
      .setCustomId(`event_join_${eventId}`)
      .setLabel('✅ 참가 / 취소')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`event_list_${eventId}`)
      .setLabel('📋 참가자 목록')
      .setStyle(ButtonStyle.Secondary)
  );
}