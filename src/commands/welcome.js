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
            .setDescription('환영 메시지 템플릿 ({{user}}, {{username}}, {{server}}, {{memberCount}} 사용 가능)')
        )
    )
    .addSubcommand((sub) =>
      sub.setName('테스트').setDescription('환영 메시지와 게임 선택 메뉴를 테스트합니다')
    )
    .addSubcommand((sub) =>
      sub.setName('상태').setDescription('현재 환영 메시지 설정을 확인합니다')
    )
    .addSubcommand((sub) =>
      sub.setName('끄기').setDescription('환영 메시지를 비활성화합니다')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case '설정': return this.configure(interaction);
      case '테스트': return this.test(interaction);
      case '상태': return this.status(interaction);
      case '끄기': return this.disable(interaction);
    }
  },

  // ============================================
  // ⚙️ 환영 메시지 설정
  // ============================================
  async configure(interaction) {
    const channel = interaction.options.getChannel('채널');
    const message = interaction.options.getString('메시지');

    await updateGuildSettings(interaction.guild.id, {
      channel_id: channel.id,
      enabled: true,
      message: message || null,
    });

    const embed = new EmbedBuilder()
      .setTitle('✅ 환영 메시지가 설정되었습니다!')
      .addFields(
        { name: '📢 채널', value: `${channel}`, inline: true },
        { name: '📍 상태', value: '✅ 활성화', inline: true },
        {
          name: '💬 메시지',
          value: message || '기본 메시지',
          inline: false,
        },
        {
          name: '🎮 게임 역할 (선택 메뉴)',
          value: GAME_ROLES.map((g) => g.label).join('\n'),
          inline: false,
        }
      )
      .setColor(0x57f287)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  // ============================================
  // 🧪 테스트 메시지
  // ============================================
  async test(interaction) {
    const settings = await getGuildSettings(interaction.guild.id);

    if (!settings || !settings.channel_id) {
      return interaction.reply({
        content: '❌ 환영 메시지가 설정되지 않았습니다. `/환영 설정`을 먼저 실행해주세요.',
        ephemeral: true,
      });
    }

    const channel = interaction.guild.channels.cache.get(settings.channel_id);
    if (!channel) {
      return interaction.reply({
        content: '❌ 설정된 환영 채널을 찾을 수 없습니다. 다시 설정해주세요.',
        ephemeral: true,
      });
    }

    const embed    = createWelcomeEmbed(interaction.member, settings);
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
    const settings = await getGuildSettings(interaction.guild.id);

    if (!settings) {
      return interaction.reply({
        content: '❌ 환영 메시지가 설정되지 않았습니다.',
        ephemeral: true,
      });
    }

    const channel = settings.channel_id
      ? interaction.guild.channels.cache.get(settings.channel_id)
      : null;

    const embed = new EmbedBuilder()
      .setTitle('👋 환영 메시지 설정 상태')
      .addFields(
        { name: '📍 상태',   value: settings.enabled ? '✅ 활성화' : '❌ 비활성화', inline: true },
        { name: '📢 채널',   value: channel ? `${channel}` : '❌ 미설정', inline: true },
        { name: '💬 메시지', value: settings.message || '기본 메시지', inline: false },
        {
          name: '🎮 게임 역할',
          value: GAME_ROLES.map((g) => {
            const role = interaction.guild.roles.cache.get(g.id);
            return role ? `${g.label} → ${role}` : `${g.label} → ❌ 역할 없음`;
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
    await updateGuildSettings(interaction.guild.id, { enabled: false });
    await interaction.reply({
      content: '✅ 환영 메시지가 비활성화되었습니다.',
      ephemeral: true,
    });
  },
};
