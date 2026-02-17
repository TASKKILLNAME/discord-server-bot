const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('서버설정')
    .setDescription('서버 설정을 변경합니다')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('정보')
        .setDescription('현재 서버 정보를 확인합니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('이름변경')
        .setDescription('서버 이름을 변경합니다')
        .addStringOption((opt) =>
          opt.setName('이름').setDescription('새 서버 이름').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('인증레벨')
        .setDescription('서버 인증 레벨을 변경합니다')
        .addIntegerOption((opt) =>
          opt
            .setName('레벨')
            .setDescription('인증 레벨')
            .setRequired(true)
            .addChoices(
              { name: '없음 - 제한 없음', value: 0 },
              { name: '낮음 - 이메일 인증', value: 1 },
              { name: '중간 - 가입 5분 이상', value: 2 },
              { name: '높음 - 멤버 10분 이상', value: 3 },
              { name: '최고 - 전화번호 인증', value: 4 }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('알림필터')
        .setDescription('서버 기본 알림 설정을 변경합니다')
        .addIntegerOption((opt) =>
          opt
            .setName('레벨')
            .setDescription('알림 레벨')
            .setRequired(true)
            .addChoices(
              { name: '모든 메시지', value: 0 },
              { name: '멘션만', value: 1 }
            )
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case '정보':
        return this.serverInfo(interaction);
      case '이름변경':
        return this.changeName(interaction);
      case '인증레벨':
        return this.changeVerification(interaction);
      case '알림필터':
        return this.changeNotification(interaction);
    }
  },

  async serverInfo(interaction) {
    const guild = interaction.guild;

    const verificationLevels = {
      0: '없음',
      1: '낮음 (이메일 인증)',
      2: '중간 (가입 5분)',
      3: '높음 (멤버 10분)',
      4: '최고 (전화번호 인증)',
    };

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${guild.name} 서버 정보`)
      .setThumbnail(guild.iconURL({ dynamic: true }))
      .addFields(
        { name: '👑 소유자', value: `<@${guild.ownerId}>`, inline: true },
        {
          name: '👥 멤버 수',
          value: `${guild.memberCount}명`,
          inline: true,
        },
        {
          name: '📝 채널 수',
          value: `${guild.channels.cache.size}개`,
          inline: true,
        },
        {
          name: '👤 역할 수',
          value: `${guild.roles.cache.size}개`,
          inline: true,
        },
        {
          name: '🔒 인증 레벨',
          value: verificationLevels[guild.verificationLevel] || '알 수 없음',
          inline: true,
        },
        {
          name: '📅 서버 생성일',
          value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`,
          inline: true,
        },
        {
          name: '💎 부스트',
          value: `${guild.premiumSubscriptionCount || 0}개 (레벨 ${guild.premiumTier})`,
          inline: true,
        },
        {
          name: '🆔 서버 ID',
          value: guild.id,
          inline: true,
        }
      )
      .setColor('#5865F2')
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  async changeName(interaction) {
    const name = interaction.options.getString('이름');

    try {
      const oldName = interaction.guild.name;
      await interaction.guild.setName(name);
      await interaction.reply({
        content: `✅ 서버 이름이 **${oldName}** → **${name}**(으)로 변경되었습니다.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content: `❌ 서버 이름 변경 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async changeVerification(interaction) {
    const level = interaction.options.getInteger('레벨');

    try {
      await interaction.guild.setVerificationLevel(level);

      const levels = ['없음', '낮음', '중간', '높음', '최고'];
      await interaction.reply({
        content: `✅ 서버 인증 레벨이 **${levels[level]}**(으)로 변경되었습니다.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content: `❌ 인증 레벨 변경 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async changeNotification(interaction) {
    const level = interaction.options.getInteger('레벨');

    try {
      await interaction.guild.setDefaultMessageNotifications(level);

      const options = ['모든 메시지', '멘션만'];
      await interaction.reply({
        content: `✅ 기본 알림 설정이 **${options[level]}**(으)로 변경되었습니다.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content: `❌ 알림 설정 변경 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },
};