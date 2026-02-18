const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const {
  getGuildSettings,
  updateGuildSettings,
  createWelcomeEmbed,
  createGameSelectMenu,
  ensureGameRoles,
  GAME_ROLES,
} = require('../services/welcomeService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('환영')
    .setDescription('환영 메시지 및 게임 역할 설정을 관리합니다')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('설정')
        .setDescription('환영 메시지를 설정합니다')
        .addChannelOption((opt) =>
          opt
            .setName('채널')
            .setDescription('환영 메시지를 보낼 채널')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
        .addStringOption((opt) =>
          opt
            .setName('메시지')
            .setDescription(
              '환영 메시지 템플릿 ({{user}}, {{username}}, {{server}}, {{memberCount}} 사용 가능)'
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('테스트')
        .setDescription('환영 메시지와 게임 선택 메뉴를 테스트합니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('상태')
        .setDescription('현재 환영 메시지 설정을 확인합니다')
    )
    .addSubcommand((sub) =>
      sub.setName('끄기').setDescription('환영 메시지를 비활성화합니다')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case '설정':
        return this.configure(interaction);
      case '테스트':
        return this.test(interaction);
      case '상태':
        return this.status(interaction);
      case '끄기':
        return this.disable(interaction);
    }
  },

  // ============================================
  // ⚙️ 환영 메시지 설정
  // ============================================
  async configure(interaction) {
    const channel = interaction.options.getChannel('채널');
    const message = interaction.options.getString('메시지');

    const settings = {
      channelId: channel.id,
      enabled: true,
    };

    if (message) {
      settings.message = message;
    }

    updateGuildSettings(interaction.guild.id, settings);

    // 🎮 게임 역할 자동 생성
    const createdRoles = await ensureGameRoles(interaction.guild);

    const embed = new EmbedBuilder()
      .setTitle('✅ 환영 메시지가 설정되었습니다!')
      .addFields(
        { name: '📢 채널', value: `${channel}`, inline: true },
        {
          name: '💬 메시지',
          value:
            message ||
            '기본 메시지 ({{user}}님, **{{server}}**에 오신 것을 환영합니다!)',
          inline: false,
        },
        {
          name: '🎮 게임 역할',
          value: GAME_ROLES.map((g) => g.label).join('\n'),
          inline: false,
        }
      )
      .setColor(0x57f287)
      .setTimestamp();

    if (createdRoles.length > 0) {
      embed.addFields({
        name: '🆕 새로 생성된 역할',
        value: createdRoles.join(', '),
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  // ============================================
  // 🧪 테스트 메시지
  // ============================================
  async test(interaction) {
    const settings = getGuildSettings(interaction.guild.id);

    if (!settings || !settings.channelId) {
      return interaction.reply({
        content: '❌ 환영 메시지가 설정되지 않았습니다. `/환영 설정`을 먼저 실행해주세요.',
        ephemeral: true,
      });
    }

    const channel = interaction.guild.channels.cache.get(settings.channelId);
    if (!channel) {
      return interaction.reply({
        content: '❌ 설정된 환영 채널을 찾을 수 없습니다. 다시 설정해주세요.',
        ephemeral: true,
      });
    }

    // 🎮 게임 역할 확인/생성
    await ensureGameRoles(interaction.guild);

    const embed = createWelcomeEmbed(interaction.member, settings);
    const gameMenu = createGameSelectMenu();

    await channel.send({
      content: '🧪 **[테스트]** 환영 메시지 미리보기:',
      embeds: [embed],
      components: [gameMenu],
    });

    await interaction.reply({
      content: `✅ 테스트 환영 메시지가 ${channel}에 전송되었습니다!`,
      ephemeral: true,
    });
  },

  // ============================================
  // 📊 상태 확인
  // ============================================
  async status(interaction) {
    const settings = getGuildSettings(interaction.guild.id);

    if (!settings) {
      return interaction.reply({
        content: '❌ 환영 메시지가 설정되지 않았습니다.',
        ephemeral: true,
      });
    }

    const channel = settings.channelId
      ? interaction.guild.channels.cache.get(settings.channelId)
      : null;

    const embed = new EmbedBuilder()
      .setTitle('👋 환영 메시지 설정 상태')
      .addFields(
        {
          name: '📍 상태',
          value: settings.enabled ? '✅ 활성화' : '❌ 비활성화',
          inline: true,
        },
        {
          name: '📢 채널',
          value: channel ? `${channel}` : '❌ 미설정',
          inline: true,
        },
        {
          name: '💬 메시지',
          value: settings.message || '기본 메시지',
          inline: false,
        },
        {
          name: '🎮 게임 역할',
          value: GAME_ROLES.map((g) => {
            const role = interaction.guild.roles.cache.find(
              (r) => r.name === g.name
            );
            return role ? `${g.label} → ${role}` : `${g.label} → ❌ 미생성`;
          }).join('\n'),
          inline: false,
        }
      )
      .setColor(0x5865f2)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  // ============================================
  // 🔇 비활성화
  // ============================================
  async disable(interaction) {
    updateGuildSettings(interaction.guild.id, { enabled: false });

    await interaction.reply({
      content: '✅ 환영 메시지가 비활성화되었습니다.',
      ephemeral: true,
    });
  },
};
