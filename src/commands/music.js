const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  addSong,
  searchAndGetInfo,
  playCurrentSong,
  connectAndSetup,
  skip,
  stop,
  pause,
  resume,
  getQueueInfo,
} = require('../services/musicService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('음악')
    .setDescription('YouTube 음악을 재생합니다')
    .addSubcommand((sub) =>
      sub
        .setName('재생')
        .setDescription('YouTube에서 음악을 검색하여 재생합니다')
        .addStringOption((opt) =>
          opt
            .setName('검색어')
            .setDescription('YouTube 검색어 또는 URL')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('정지').setDescription('재생을 중지하고 봇이 퇴장합니다')
    )
    .addSubcommand((sub) =>
      sub.setName('스킵').setDescription('현재 곡을 건너뜁니다')
    )
    .addSubcommand((sub) =>
      sub.setName('대기열').setDescription('현재 재생 대기열을 확인합니다')
    )
    .addSubcommand((sub) =>
      sub.setName('일시정지').setDescription('음악을 일시정지합니다')
    )
    .addSubcommand((sub) =>
      sub.setName('다시재생').setDescription('일시정지된 음악을 다시 재생합니다')
    ),

  async execute(interaction) {
    // 클라우드 환경 체크
    if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) {
      return interaction.reply({
        content: '⚠️ 현재 클라우드 환경에서 운영 중이라 음악 기능을 사용할 수 없습니다.\n> 클라우드 서비스(Railway)는 UDP 연결을 지원하지 않아 음성채널 접속이 불가합니다.',
        ephemeral: true,
      });
    }

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case '재생':
        return this.handlePlay(interaction);
      case '정지':
        return this.handleStop(interaction);
      case '스킵':
        return this.handleSkip(interaction);
      case '대기열':
        return this.handleQueue(interaction);
      case '일시정지':
        return this.handlePause(interaction);
      case '다시재생':
        return this.handleResume(interaction);
    }
  },

  async handlePlay(interaction) {
    const query = interaction.options.getString('검색어');

    // 음성채널 확인
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: '❌ 먼저 음성채널에 접속해주세요!',
        ephemeral: true,
      });
    }

    // 봇 권한 확인
    const permissions = voiceChannel.permissionsFor(interaction.guild.members.me);
    if (!permissions.has('Connect') || !permissions.has('Speak')) {
      return interaction.reply({
        content: '❌ 봇에 음성채널 접속/말하기 권한이 없습니다.',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      // YouTube 검색
      const songInfo = await searchAndGetInfo(query);
      if (!songInfo) {
        return interaction.editReply({
          content: '❌ 검색 결과를 찾을 수 없습니다.',
        });
      }

      const guildId = interaction.guild.id;

      // 대기열에 추가
      const position = addSong(guildId, songInfo);

      // 음성채널 연결
      await connectAndSetup(
        guildId,
        voiceChannel,
        interaction.channel,
        interaction.guild.voiceAdapterCreator
      );

      const queueInfo = getQueueInfo(guildId);

      if (!queueInfo.playing) {
        // 재생 시작
        await playCurrentSong(guildId);

        const embed = new EmbedBuilder()
          .setTitle('🎵 지금 재생')
          .setDescription(`**[${songInfo.title}](${songInfo.url})**`)
          .addFields(
            { name: '⏱️ 길이', value: songInfo.duration, inline: true },
            { name: '📺 채널', value: songInfo.channel, inline: true },
            { name: '🔊 음성채널', value: voiceChannel.name, inline: true }
          )
          .setColor(0xFF0000);

        if (songInfo.thumbnail) {
          embed.setThumbnail(songInfo.thumbnail);
        }

        await interaction.editReply({ embeds: [embed] });
      } else {
        // 대기열에 추가됨
        const embed = new EmbedBuilder()
          .setTitle('✅ 대기열에 추가')
          .setDescription(`**[${songInfo.title}](${songInfo.url})**`)
          .addFields(
            { name: '⏱️ 길이', value: songInfo.duration, inline: true },
            { name: '📺 채널', value: songInfo.channel, inline: true },
            { name: '🔢 대기열 순서', value: `${position}번째`, inline: true }
          )
          .setColor(0x00FF00);

        if (songInfo.thumbnail) {
          embed.setThumbnail(songInfo.thumbnail);
        }

        await interaction.editReply({ embeds: [embed] });
      }
    } catch (err) {
      console.error('음악 재생 오류:', err);
      await interaction.editReply({
        content: `❌ 음악 재생 실패: ${err.message}`,
      });
    }
  },

  async handleStop(interaction) {
    const guildId = interaction.guild.id;
    stop(guildId);

    await interaction.reply({
      content: '⏹️ 재생을 중지하고 퇴장합니다.',
    });
  },

  async handleSkip(interaction) {
    const guildId = interaction.guild.id;
    const queueInfo = getQueueInfo(guildId);

    if (!queueInfo.playing) {
      return interaction.reply({
        content: '❌ 현재 재생 중인 곡이 없습니다.',
        ephemeral: true,
      });
    }

    const skippedSong = queueInfo.songs[0];
    skip(guildId);

    await interaction.reply({
      content: `⏭️ **${skippedSong?.title || '현재 곡'}**을(를) 건너뛰었습니다.`,
    });
  },

  async handleQueue(interaction) {
    const guildId = interaction.guild.id;
    const queueInfo = getQueueInfo(guildId);

    if (queueInfo.songs.length === 0) {
      return interaction.reply({
        content: '📭 대기열이 비어있습니다.',
        ephemeral: true,
      });
    }

    const nowPlaying = queueInfo.songs[0];
    const upcoming = queueInfo.songs.slice(1, 11); // 최대 10곡 표시

    let description = `**지금 재생 중:**\n🎵 [${nowPlaying.title}](${nowPlaying.url}) [${nowPlaying.duration}]\n`;

    if (upcoming.length > 0) {
      description += '\n**다음 곡:**\n';
      upcoming.forEach((song, i) => {
        description += `**${i + 1}.** [${song.title}](${song.url}) [${song.duration}]\n`;
      });
    }

    if (queueInfo.songs.length > 11) {
      description += `\n... 그 외 ${queueInfo.songs.length - 11}곡`;
    }

    const totalDuration = queueInfo.songs.reduce((acc, s) => acc + (s.durationSec || 0), 0);

    const embed = new EmbedBuilder()
      .setTitle('📋 재생 대기열')
      .setDescription(description)
      .setFooter({ text: `총 ${queueInfo.songs.length}곡 | 총 길이: ${formatTotalDuration(totalDuration)}` })
      .setColor(0x5865F2);

    await interaction.reply({ embeds: [embed] });
  },

  async handlePause(interaction) {
    const guildId = interaction.guild.id;
    const queueInfo = getQueueInfo(guildId);

    if (!queueInfo.playing) {
      return interaction.reply({
        content: '❌ 현재 재생 중인 곡이 없습니다.',
        ephemeral: true,
      });
    }

    pause(guildId);
    await interaction.reply({ content: '⏸️ 일시정지되었습니다.' });
  },

  async handleResume(interaction) {
    const guildId = interaction.guild.id;

    resume(guildId);
    await interaction.reply({ content: '▶️ 다시 재생합니다.' });
  },
};

/**
 * 총 재생 시간 포맷
 */
function formatTotalDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}시간 ${m}분`;
  }
  return `${m}분 ${s}초`;
}
