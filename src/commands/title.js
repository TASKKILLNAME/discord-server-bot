const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');
const {
  setTitle,
  removeTitle,
  getTitle,
  getAllTitles,
  applyTitle,
  removeNickTitle,
} = require('../services/titleService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('칭호')
    .setDescription('멤버 칭호 관리')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('부여')
        .setDescription('멤버에게 칭호를 부여합니다')
        .addUserOption((opt) =>
          opt.setName('유저').setDescription('칭호를 부여할 멤버').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('칭호명').setDescription('부여할 칭호 (예: MVP, 고인물)').setRequired(true).setMaxLength(20)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('해제')
        .setDescription('멤버의 칭호를 해제합니다')
        .addUserOption((opt) =>
          opt.setName('유저').setDescription('칭호를 해제할 멤버').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('확인')
        .setDescription('멤버의 칭호를 확인합니다')
        .addUserOption((opt) =>
          opt.setName('유저').setDescription('확인할 멤버').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('목록')
        .setDescription('서버의 모든 칭호를 확인합니다')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case '부여': return this.grant(interaction);
      case '해제': return this.revoke(interaction);
      case '확인': return this.check(interaction);
      case '목록': return this.list(interaction);
    }
  },

  async grant(interaction) {
    const target = interaction.options.getMember('유저');
    const title = interaction.options.getString('칭호명');

    if (!target) {
      return interaction.reply({ content: '❌ 해당 멤버를 찾을 수 없습니다.', ephemeral: true });
    }

    if (target.user.bot) {
      return interaction.reply({ content: '❌ 봇에게는 칭호를 부여할 수 없습니다.', ephemeral: true });
    }

    // 서버 주인에게는 닉네임 변경 불가
    if (target.id === interaction.guild.ownerId) {
      return interaction.reply({ content: '❌ 서버 소유자의 닉네임은 변경할 수 없습니다.', ephemeral: true });
    }

    const originalNick = target.nickname || target.user.displayName;

    try {
      await applyTitle(target, title);
      await setTitle(interaction.guild.id, target.id, title, interaction.user.id, originalNick);

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ 칭호 부여 완료')
            .addFields(
              { name: '대상', value: `${target}`, inline: true },
              { name: '칭호', value: `\`[${title}]\``, inline: true },
              { name: '부여자', value: `${interaction.user}`, inline: true },
            )
            .setColor(0x57F287)
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('칭호 부여 오류:', err);
      await interaction.reply({
        content: `❌ 칭호 부여 실패: ${err.message}\n봇의 역할이 대상보다 높은지 확인해주세요.`,
        ephemeral: true,
      });
    }
  },

  async revoke(interaction) {
    const target = interaction.options.getMember('유저');

    if (!target) {
      return interaction.reply({ content: '❌ 해당 멤버를 찾을 수 없습니다.', ephemeral: true });
    }

    const existing = await getTitle(interaction.guild.id, target.id);
    if (!existing) {
      return interaction.reply({ content: '❌ 해당 멤버에게 칭호가 없습니다.', ephemeral: true });
    }

    try {
      await removeNickTitle(target, existing.original_nick);
      await removeTitle(interaction.guild.id, target.id);

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ 칭호 해제 완료')
            .addFields(
              { name: '대상', value: `${target}`, inline: true },
              { name: '해제된 칭호', value: `\`[${existing.title}]\``, inline: true },
            )
            .setColor(0xED4245)
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('칭호 해제 오류:', err);
      await interaction.reply({ content: `❌ 칭호 해제 실패: ${err.message}`, ephemeral: true });
    }
  },

  async check(interaction) {
    const target = interaction.options.getMember('유저') || interaction.member;
    const existing = await getTitle(interaction.guild.id, target.id);

    if (!existing) {
      return interaction.reply({
        content: `${target.user.bot ? '봇' : target.displayName}에게 칭호가 없습니다.`,
        ephemeral: true,
      });
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${target.displayName}의 칭호`)
          .addFields(
            { name: '칭호', value: `\`[${existing.title}]\``, inline: true },
            { name: '부여자', value: existing.set_by ? `<@${existing.set_by}>` : '알 수 없음', inline: true },
            { name: '부여일', value: `<t:${Math.floor(new Date(existing.set_at).getTime() / 1000)}:R>`, inline: true },
          )
          .setColor(0x5865F2)
          .setThumbnail(target.user.displayAvatarURL()),
      ],
      ephemeral: true,
    });
  },

  async list(interaction) {
    const titles = await getAllTitles(interaction.guild.id);

    if (titles.length === 0) {
      return interaction.reply({ content: '이 서버에 칭호가 부여된 멤버가 없습니다.', ephemeral: true });
    }

    const lines = titles.map((t, i) =>
      `${i + 1}. <@${t.user_id}> — \`[${t.title}]\``
    );

    // 2000자 제한 대비 분할
    const desc = lines.join('\n').substring(0, 4000);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`📋 칭호 목록 (${titles.length}명)`)
          .setDescription(desc)
          .setColor(0x5865F2)
          .setTimestamp(),
      ],
      ephemeral: true,
    });
  },
};
