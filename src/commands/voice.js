const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const {
  isRoomOwner,
  isTempChannel,
  findExistingRoom,
  isStaff,
} = require('../services/tempVoiceService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('방설정')
    .setDescription('내 임시 음성채널을 관리합니다')
    .addSubcommand(sub =>
      sub.setName('이름')
        .setDescription('방 이름을 변경합니다')
        .addStringOption(opt =>
          opt.setName('이름').setDescription('새 방 이름').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('제한')
        .setDescription('인원 제한을 설정합니다')
        .addIntegerOption(opt =>
          opt.setName('인원').setDescription('최대 인원 (0=무제한)').setRequired(true)
            .setMinValue(0).setMaxValue(99)
        )
    )
    .addSubcommand(sub =>
      sub.setName('잠금')
        .setDescription('방을 잠급니다 (새 입장 차단)')
    )
    .addSubcommand(sub =>
      sub.setName('공개')
        .setDescription('방 잠금을 해제합니다')
    )
    .addSubcommand(sub =>
      sub.setName('초대')
        .setDescription('유저를 방에 초대합니다 (잠긴 방에서도 입장 가능)')
        .addUserOption(opt =>
          opt.setName('유저').setDescription('초대할 유저').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('추방')
        .setDescription('유저를 방에서 내보냅니다')
        .addUserOption(opt =>
          opt.setName('유저').setDescription('추방할 유저').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('음소거해제')
        .setDescription('서버 음소거/귀막기를 해제합니다 (운영진 전용)')
        .addUserOption(opt =>
          opt.setName('유저').setDescription('대상 (비우면 나 자신)')
        )
    ),

  async execute(interaction) {
    const member = interaction.member;
    const sub = interaction.options.getSubcommand();

    // 음소거해제는 임시방/방장 제약 없이 운영진이 어디서든 쓸 수 있어야 한다
    // (서버 음소거는 디스코드 클라이언트에서 본인이 직접 풀 수 없기 때문)
    if (sub === '음소거해제') return this.unmute(interaction);

    // 음성채널에 있는지 확인
    const voiceChannel = member.voice.channel;
    if (!voiceChannel || !isTempChannel(voiceChannel.id)) {
      return interaction.reply({
        content: '❌ 임시 음성채널에 있을 때만 사용할 수 있어요!',
        ephemeral: true,
      });
    }

    // 방장이거나 운영진이어야 함 (운영진은 어느 방이든 개입 가능)
    if (!isRoomOwner(voiceChannel.id, member.id) && !isStaff(member)) {
      return interaction.reply({
        content: '❌ 방장만 방 설정을 변경할 수 있어요!',
        ephemeral: true,
      });
    }

    switch (sub) {
      case '이름':   return this.rename(interaction, voiceChannel);
      case '제한':   return this.setLimit(interaction, voiceChannel);
      case '잠금':   return this.lock(interaction, voiceChannel);
      case '공개':   return this.unlock(interaction, voiceChannel);
      case '초대':   return this.invite(interaction, voiceChannel);
      case '추방':   return this.kick(interaction, voiceChannel);
    }
  },

  async rename(interaction, channel) {
    const name = interaction.options.getString('이름');
    await channel.setName(`🔊 ${name}`);
    await interaction.reply({
      content: `✅ 방 이름이 **${name}**으로 변경됐어요!`,
      ephemeral: true,
    });
  },

  async setLimit(interaction, channel) {
    const limit = interaction.options.getInteger('인원');
    await channel.setUserLimit(limit);
    await interaction.reply({
      content: limit === 0
        ? '✅ 인원 제한이 해제됐어요!'
        : `✅ 인원 제한이 **${limit}명**으로 설정됐어요!`,
      ephemeral: true,
    });
  },

  async lock(interaction, channel) {
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
      Connect: false,
    });
    await interaction.reply({
      content: '🔒 방이 잠겼어요! `/방설정 초대`로 유저를 초대할 수 있어요.',
      ephemeral: true,
    });
  },

  async unlock(interaction, channel) {
    await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
      Connect: null, // 카테고리 권한 상속
    });
    await interaction.reply({
      content: '🔓 방이 공개됐어요!',
      ephemeral: true,
    });
  },

  async invite(interaction, channel) {
    const target = interaction.options.getUser('유저');
    await channel.permissionOverwrites.edit(target.id, {
      Connect: true,
      ViewChannel: true,
    });
    await interaction.reply({
      content: `✅ **${target.username}**님을 초대했어요! 이제 입장할 수 있어요.`,
      ephemeral: true,
    });
  },

  async kick(interaction, channel) {
    const target = interaction.options.getUser('유저');
    const targetMember = await interaction.guild.members.fetch(target.id);

    // 운영진은 자기보다 낮은 사람에게 추방당하지 않는다
    if (
      isStaff(targetMember) &&
      targetMember.roles.highest.position >= interaction.member.roles.highest.position &&
      targetMember.id !== interaction.member.id
    ) {
      return interaction.reply({
        content: '❌ 운영진은 방에서 내보낼 수 없어요.',
        ephemeral: true,
      });
    }

    if (targetMember.voice.channelId === channel.id) {
      await targetMember.voice.disconnect('방장에 의해 추방');
    }
    await channel.permissionOverwrites.edit(target.id, {
      Connect: false,
    });
    await interaction.reply({
      content: `✅ **${target.username}**님을 방에서 내보냈어요.`,
      ephemeral: true,
    });
  },

  async unmute(interaction) {
    if (!isStaff(interaction.member)) {
      return interaction.reply({
        content: '❌ 운영진만 사용할 수 있어요!',
        ephemeral: true,
      });
    }

    const target = interaction.options.getUser('유저');
    const targetMember = target
      ? await interaction.guild.members.fetch(target.id).catch(() => null)
      : interaction.member;

    if (!targetMember) {
      return interaction.reply({ content: '❌ 유저를 찾을 수 없어요.', ephemeral: true });
    }
    if (!targetMember.voice.channelId) {
      return interaction.reply({
        content: '❌ 대상이 음성 채널에 접속해 있어야 해제할 수 있어요.',
        ephemeral: true,
      });
    }
    if (!targetMember.voice.serverMute && !targetMember.voice.serverDeaf) {
      return interaction.reply({
        content: 'ℹ️ 서버 음소거/귀막기 상태가 아니에요. (본인이 직접 끈 마이크는 직접 켜야 해요)',
        ephemeral: true,
      });
    }

    try {
      await targetMember.voice.edit({
        mute: false,
        deaf: false,
        reason: `${interaction.user.tag} 운영진 음소거 해제`,
      });
    } catch (err) {
      return interaction.reply({
        content: `❌ 해제 실패: ${err.message}\n(봇에 "멤버 음소거" 권한이 있는지 확인해주세요)`,
        ephemeral: true,
      });
    }

    await interaction.reply({
      content: targetMember.id === interaction.member.id
        ? '✅ 서버 음소거/귀막기를 해제했어요.'
        : `✅ **${targetMember.user.username}**님의 서버 음소거/귀막기를 해제했어요.`,
      ephemeral: true,
    });
  },
};
