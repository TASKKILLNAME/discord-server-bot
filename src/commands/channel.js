const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const { sleep } = require('../utils/serverSetup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('채널')
    .setDescription('채널을 관리합니다')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((sub) =>
      sub
        .setName('생성')
        .setDescription('새 채널을 생성합니다')
        .addStringOption((opt) =>
          opt.setName('이름').setDescription('채널 이름').setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('종류')
            .setDescription('채널 종류')
            .setRequired(true)
            .addChoices(
              { name: '💬 텍스트', value: 'text' },
              { name: '🔊 음성', value: 'voice' },
              { name: '📁 카테고리', value: 'category' },
              { name: '📢 공지', value: 'announcement' },
              { name: '🧵 포럼', value: 'forum' }
            )
        )
        .addChannelOption((opt) =>
          opt
            .setName('카테고리')
            .setDescription('소속 카테고리')
            .addChannelTypes(ChannelType.GuildCategory)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('삭제')
        .setDescription('채널을 삭제합니다')
        .addChannelOption((opt) =>
          opt.setName('채널').setDescription('삭제할 채널').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('이동')
        .setDescription('채널을 다른 카테고리로 이동합니다')
        .addChannelOption((opt) =>
          opt.setName('채널').setDescription('이동할 채널').setRequired(true)
        )
        .addChannelOption((opt) =>
          opt
            .setName('카테고리')
            .setDescription('이동할 카테고리')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('잠금')
        .setDescription('채널을 잠급니다 (메시지 전송 불가)')
        .addChannelOption((opt) =>
          opt.setName('채널').setDescription('잠글 채널').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('잠금해제')
        .setDescription('채널 잠금을 해제합니다')
        .addChannelOption((opt) =>
          opt.setName('채널').setDescription('잠금 해제할 채널').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('대량생성')
        .setDescription('여러 채널을 한번에 생성합니다')
        .addStringOption((opt) =>
          opt
            .setName('이름들')
            .setDescription('채널 이름들 (쉼표로 구분: 일반, 공지, 자유)')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('종류')
            .setDescription('채널 종류')
            .setRequired(true)
            .addChoices(
              { name: '💬 텍스트', value: 'text' },
              { name: '🔊 음성', value: 'voice' }
            )
        )
        .addChannelOption((opt) =>
          opt
            .setName('카테고리')
            .setDescription('소속 카테고리')
            .addChannelTypes(ChannelType.GuildCategory)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case '생성':
        return this.createChannel(interaction);
      case '삭제':
        return this.deleteChannel(interaction);
      case '이동':
        return this.moveChannel(interaction);
      case '잠금':
        return this.lockChannel(interaction);
      case '잠금해제':
        return this.unlockChannel(interaction);
      case '대량생성':
        return this.bulkCreate(interaction);
    }
  },

  async createChannel(interaction) {
    const name = interaction.options.getString('이름');
    const type = interaction.options.getString('종류');
    const category = interaction.options.getChannel('카테고리');

    const typeMap = {
      text: ChannelType.GuildText,
      voice: ChannelType.GuildVoice,
      category: ChannelType.GuildCategory,
      announcement: ChannelType.GuildAnnouncement,
      forum: ChannelType.GuildForum,
    };

    try {
      const channel = await interaction.guild.channels.create({
        name,
        type: typeMap[type],
        parent: category?.id,
        reason: `${interaction.user.tag}에 의해 생성됨`,
      });

      const embed = new EmbedBuilder()
        .setTitle('✅ 채널 생성 완료')
        .setDescription(`${channel} 채널이 생성되었습니다!`)
        .setColor('#00FF00');

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (err) {
      await interaction.reply({
        content: `❌ 채널 생성 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async deleteChannel(interaction) {
    const channel = interaction.options.getChannel('채널');

    try {
      const channelName = channel.name;
      await channel.delete(`${interaction.user.tag}에 의해 삭제됨`);

      await interaction.reply({
        content: `✅ **${channelName}** 채널이 삭제되었습니다.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content: `❌ 채널 삭제 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async moveChannel(interaction) {
    const channel = interaction.options.getChannel('채널');
    const category = interaction.options.getChannel('카테고리');

    try {
      await channel.setParent(category.id, { lockPermissions: false });
      await interaction.reply({
        content: `✅ ${channel}을(를) **${category.name}** 카테고리로 이동했습니다.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({
        content: `❌ 채널 이동 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async lockChannel(interaction) {
    const channel = interaction.options.getChannel('채널');

    try {
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: false,
      });

      const embed = new EmbedBuilder()
        .setTitle('🔒 채널 잠금')
        .setDescription(`${channel} 채널이 잠겼습니다.`)
        .setColor('#FF0000');

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply({
        content: `❌ 채널 잠금 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async unlockChannel(interaction) {
    const channel = interaction.options.getChannel('채널');

    try {
      await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: true,
      });

      const embed = new EmbedBuilder()
        .setTitle('🔓 채널 잠금 해제')
        .setDescription(`${channel} 채널의 잠금이 해제되었습니다.`)
        .setColor('#00FF00');

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply({
        content: `❌ 채널 잠금 해제 실패: ${err.message}`,
        ephemeral: true,
      });
    }
  },

  async bulkCreate(interaction) {
    const names = interaction.options
      .getString('이름들')
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n);
    const type = interaction.options.getString('종류');
    const category = interaction.options.getChannel('카테고리');

    const typeMap = {
      text: ChannelType.GuildText,
      voice: ChannelType.GuildVoice,
    };

    await interaction.deferReply({ ephemeral: true });

    const created = [];
    const failed = [];

    for (const name of names) {
      try {
        const channel = await interaction.guild.channels.create({
          name,
          type: typeMap[type],
          parent: category?.id,
          reason: `${interaction.user.tag}에 의한 대량 생성`,
        });
        created.push(channel.name);
        await sleep(300);
      } catch (err) {
        failed.push(`${name}: ${err.message}`);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('📝 대량 채널 생성 결과')
      .setColor(failed.length === 0 ? '#00FF00' : '#FFA500')
      .addFields(
        { name: '✅ 생성 완료', value: created.join(', ') || '없음' },
        { name: '❌ 실패', value: failed.join('\n') || '없음' }
      );

    await interaction.editReply({ embeds: [embed] });
  },
};