const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('역할')
    .setDescription('역할을 관리합니다')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((sub) =>
      sub
        .setName('생성')
        .setDescription('새 역할을 생성합니다')
        .addStringOption((opt) =>
          opt.setName('이름').setDescription('역할 이름').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('색상').setDescription('색상 코드 (예: #FF0000)')
        )
        .addBooleanOption((opt) =>
          opt.setName('분리표시').setDescription('멤버 목록에서 분리 표시')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('삭제')
        .setDescription('역할을 삭제합니다')
        .addRoleOption((opt) =>
          opt.setName('역할').setDescription('삭제할 역할').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('부여')
        .setDescription('멤버에게 역할을 부여합니다')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('대상 멤버').setRequired(true)
        )
        .addRoleOption((opt) =>
          opt.setName('역할').setDescription('부여할 역할').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('제거')
        .setDescription('멤버에서 역할을 제거합니다')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('대상 멤버').setRequired(true)
        )
        .addRoleOption((opt) =>
          opt.setName('역할').setDescription('제거할 역할').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('목록')
        .setDescription('서버의 모든 역할을 표시합니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('색상변경')
        .setDescription('역할의 색상을 변경합니다')
        .addRoleOption((opt) =>
          opt.setName('역할').setDescription('대상 역할').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('색상').setDescription('새 색상 코드 (예: #FF0000)').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('전체부여')
        .setDescription('모든 멤버에게 역할을 부여합니다')
        .addRoleOption((opt) =>
          opt.setName('역할').setDescription('부여할 역할').setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case '생성':
        return this.createRole(interaction);
      case '삭제':
        return this.deleteRole(interaction);
      case '부여':
        return this.assignRole(interaction);
      case '제거':
        return this.removeRole(interaction);
      case '목록':
        return this.listRoles(interaction);
      case '색상변경':
        return this.changeColor(interaction);
      case '전체부여':
        return this.assignAll(interaction);
    }
  },

  async createRole(interaction) {
    const name = interaction.options.getString('이름');
    const color = interaction.options.getString('색상') || '#000000';
    const hoist = interaction.options.getBoolean('분리표시') ?? false;

    try {
      const role = await interaction.guild.roles.create({
        name,
        color,
        hoist,
        reason: `${interaction.user.tag}에 의해 생성됨`,
      });

      const embed = new EmbedBuilder()
        .setTitle('✅ 역할 생성 완료')
        .setDescription(`${role} 역할이 생성되었습니다!`)
        .addFields(
          { name: '이름', value: role.name, inline: true },
          { name: '색상', value: color, inline: true },
          { name: '분리표시', value: hoist ? '예' : '아니오', inline: true }
        )
        .setColor(color);

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (err) {
      await interaction.reply({
        content: `❌ 역할 생성 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async deleteRole(interaction) {
    const role = interaction.options.getRole('역할');

    try {
      const roleName = role.name;
      await role.delete(`${interaction.user.tag}에 의해 삭제됨`);
      await interaction.reply({
        content: `✅ **${roleName}** 역할이 삭제되었습니다.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content: `❌ 역할 삭제 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async assignRole(interaction) {
    const member = interaction.options.getMember('멤버');
    const role = interaction.options.getRole('역할');

    try {
      await member.roles.add(role);
      await interaction.reply({
        content: `✅ ${member}에게 ${role} 역할을 부여했습니다.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content: `❌ 역할 부여 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async removeRole(interaction) {
    const member = interaction.options.getMember('멤버');
    const role = interaction.options.getRole('역할');

    try {
      await member.roles.remove(role);
      await interaction.reply({
        content: `✅ ${member}에서 ${role} 역할을 제거했습니다.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content: `❌ 역할 제거 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async listRoles(interaction) {
    const roles = interaction.guild.roles.cache
      .filter((r) => r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .map(
        (r) =>
          `${r} - ${r.members.size}명 | ${r.hexColor}`
      );

    const embed = new EmbedBuilder()
      .setTitle(`📋 ${interaction.guild.name}의 역할 목록`)
      .setDescription(roles.join('\n') || '역할이 없습니다.')
      .setColor('#5865F2')
      .setFooter({ text: `총 ${roles.length}개 역할` });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  async changeColor(interaction) {
    const role = interaction.options.getRole('역할');
    const color = interaction.options.getString('색상');

    try {
      await role.setColor(color);
      await interaction.reply({
        content: `✅ ${role} 역할의 색상이 **${color}**으로 변경되었습니다.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content: `❌ 색상 변경 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async assignAll(interaction) {
    const role = interaction.options.getRole('역할');

    await interaction.deferReply({ ephemeral: true });

    try {
      const members = await interaction.guild.members.fetch();
      let count = 0;

      for (const [, member] of members) {
        if (!member.roles.cache.has(role.id) && !member.user.bot) {
          await member.roles.add(role);
          count++;
          // Rate limit 방지
          if (count % 5 === 0) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }

      await interaction.editReply({
        content: `✅ ${count}명의 멤버에게 ${role} 역할을 부여했습니다.`,
      });
    } catch (err) {
      await interaction.editReply({
        content: `❌ 전체 역할 부여 실패: ${err.message}`,
      });
    }
  },
};