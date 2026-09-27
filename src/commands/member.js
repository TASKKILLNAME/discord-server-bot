const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('멤버')
    .setDescription('멤버를 관리합니다')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((sub) =>
      sub
        .setName('정보')
        .setDescription('멤버 정보를 확인합니다')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('대상 멤버').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('킥')
        .setDescription('멤버를 서버에서 추방합니다')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('추방할 멤버').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('사유').setDescription('추방 사유')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('밴')
        .setDescription('멤버를 차단합니다')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('차단할 멤버').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('사유').setDescription('차단 사유')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('언밴')
        .setDescription('멤버의 차단을 해제합니다')
        .addStringOption((opt) =>
          opt.setName('유저id').setDescription('언밴할 유저 ID').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('타임아웃')
        .setDescription('멤버를 일시적으로 제한합니다')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('대상 멤버').setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('시간')
            .setDescription('제한 시간 (분)')
            .setRequired(true)
            .addChoices(
              { name: '1분', value: 1 },
              { name: '5분', value: 5 },
              { name: '10분', value: 10 },
              { name: '30분', value: 30 },
              { name: '1시간', value: 60 },
              { name: '1일', value: 1440 },
              { name: '1주', value: 10080 }
            )
        )
        .addStringOption((opt) =>
          opt.setName('사유').setDescription('제한 사유')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('닉네임')
        .setDescription('멤버의 닉네임을 변경합니다')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('대상 멤버').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('닉네임').setDescription('새 닉네임').setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case '정보':
        return this.memberInfo(interaction);
      case '킥':
        return this.kickMember(interaction);
      case '밴':
        return this.banMember(interaction);
      case '언밴':
        return this.unbanMember(interaction);
      case '타임아웃':
        return this.timeoutMember(interaction);
      case '닉네임':
        return this.changeNickname(interaction);
    }
  },

  async memberInfo(interaction) {
    const member = interaction.options.getMember('멤버');

    const roles = member.roles.cache
      .filter((r) => r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .map((r) => `${r}`)
      .join(', ');

    const embed = new EmbedBuilder()
      .setTitle(`👤 ${member.displayName} 정보`)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .addFields(
        { name: '🏷️ 태그', value: member.user.tag, inline: true },
        { name: '🆔 ID', value: member.id, inline: true },
        {
          name: '📅 서버 가입일',
          value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`,
          inline: true,
        },
        {
          name: '📅 계정 생성일',
          value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
          inline: true,
        },
        {
          name: `👤 역할 (${member.roles.cache.size - 1})`,
          value: roles || '없음',
        },
        {
          name: '🤖 봇 여부',
          value: member.user.bot ? '예' : '아니오',
          inline: true,
        }
      )
      .setColor(member.displayHexColor || '#5865F2');

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  async kickMember(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: '❌ 킥은 관리자만 사용할 수 있습니다.',
        ephemeral: true,
      });
    }

    const member = interaction.options.getMember('멤버');
    const reason = interaction.options.getString('사유') || '사유 없음';

    if (!member.kickable) {
      return interaction.reply({
        content: '❌ 이 멤버를 추방할 권한이 없습니다.',
        ephemeral: true,
      });
    }

    try {
      await member.kick(reason);
      const embed = new EmbedBuilder()
        .setTitle('👢 멤버 추방')
        .setDescription(`**${member.user.tag}**이(가) 추방되었습니다.`)
        .addFields({ name: '사유', value: reason })
        .setColor('#FFA500');

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply({
        content: `❌ 추방 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async banMember(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: '❌ 밴은 관리자만 사용할 수 있습니다.',
        ephemeral: true,
      });
    }

    const member = interaction.options.getMember('멤버');
    const reason = interaction.options.getString('사유') || '사유 없음';

    if (!member.bannable) {
      return interaction.reply({
        content: '❌ 이 멤버를 차단할 권한이 없습니다.',
        ephemeral: true,
      });
    }

    try {
      await member.ban({ reason });
      const embed = new EmbedBuilder()
        .setTitle('🔨 멤버 차단')
        .setDescription(`**${member.user.tag}**이(가) 차단되었습니다.`)
        .addFields({ name: '사유', value: reason })
        .setColor('#FF0000');

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply({
        content: `❌ 차단 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async unbanMember(interaction) {
    const userId = interaction.options.getString('유저id');

    try {
      await interaction.guild.members.unban(userId);
      await interaction.reply({
        content: `✅ 유저 ID **${userId}**의 차단이 해제되었습니다.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content: `❌ 언밴 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async timeoutMember(interaction) {
    const member = interaction.options.getMember('멤버');
    const minutes = interaction.options.getInteger('시간');
    const reason = interaction.options.getString('사유') || '사유 없음';

    try {
      await member.timeout(minutes * 60 * 1000, reason);

      const embed = new EmbedBuilder()
        .setTitle('⏰ 타임아웃')
        .setDescription(
          `**${member.displayName}**이(가) ${minutes}분 동안 타임아웃되었습니다.`
        )
        .addFields({ name: '사유', value: reason })
        .setColor('#FFA500');

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply({
        content: `❌ 타임아웃 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async changeNickname(interaction) {
    const member = interaction.options.getMember('멤버');
    const nickname = interaction.options.getString('닉네임');

    try {
      await member.setNickname(nickname);
      await interaction.reply({
        content: `✅ ${member}의 닉네임이 **${nickname}**(으)로 변경되었습니다.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content: `❌ 닉네임 변경 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },
};
