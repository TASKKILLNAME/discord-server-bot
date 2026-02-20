const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const {
  TIERS,
  getCredits,
  getMembershipInfo,
  chargeCredits,
  setMembershipChannel,
  getMembershipChannel,
} = require('../services/membershipService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('멤버십')
    .setDescription('AI 분석 크레딧 멤버십 관리')
    .addSubcommand((sub) =>
      sub.setName('구매').setDescription('AI 분석 크레딧을 구매합니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('충전')
        .setDescription('멤버에게 크레딧을 충전합니다 (관리자)')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('충전할 멤버').setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName('횟수').setDescription('충전할 크레딧 수').setRequired(true).setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('정보')
        .setDescription('멤버십 정보를 확인합니다')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('조회할 멤버 (미입력 시 본인)')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('설정')
        .setDescription('멤버십 구매 요청 알림 채널을 설정합니다 (관리자)')
        .addChannelOption((opt) =>
          opt
            .setName('채널')
            .setDescription('구매 요청 알림 채널')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case '구매':
        return this.purchase(interaction);
      case '충전':
        return this.charge(interaction);
      case '정보':
        return this.info(interaction);
      case '설정':
        return this.setChannel(interaction);
    }
  },

  // ============================================
  // 🛒 구매 요청
  // ============================================
  async purchase(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('💳 AI 분석 크레딧 구매')
      .setDescription(
        '원하는 멤버십 티어를 선택해주세요.\n' +
          '구매 요청 후 관리자가 입금 확인하면 크레딧이 충전됩니다.\n\n' +
          `현재 잔여 크레딧: **${getCredits(interaction.guild.id, interaction.user.id)}회**`
      )
      .addFields(
        { name: '🥉 브론즈', value: '**1,000원** — 8회', inline: true },
        { name: '🥈 실버', value: '**5,000원** — 40회', inline: true },
        { name: '🥇 골드', value: '**10,000원** — 83회', inline: true }
      )
      .setColor(0xf0b232)
      .setFooter({ text: '버튼을 클릭하여 구매 요청을 보내세요' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('membership_buy_bronze')
        .setLabel('🥉 브론즈 1,000원')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('membership_buy_silver')
        .setLabel('🥈 실버 5,000원')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('membership_buy_gold')
        .setLabel('🥇 골드 10,000원')
        .setStyle(ButtonStyle.Success)
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  },

  // ============================================
  // 🔘 버튼 핸들러
  // ============================================
  async handleButton(interaction) {
    const tierKey = interaction.customId.replace('membership_buy_', '');
    const tier = TIERS[tierKey];

    if (!tier) {
      return interaction.reply({ content: '❌ 알 수 없는 티어입니다.', ephemeral: true });
    }

    // 구매 요청 알림 채널 확인
    const notifyChannelId = getMembershipChannel(interaction.guild.id);

    if (!notifyChannelId) {
      return interaction.reply({
        content: '❌ 멤버십 관리 채널이 설정되지 않았습니다.\n관리자에게 `/멤버십 설정`을 요청해주세요.',
        ephemeral: true,
      });
    }

    const notifyChannel = interaction.guild.channels.cache.get(notifyChannelId);
    if (!notifyChannel) {
      return interaction.reply({
        content: '❌ 멤버십 관리 채널을 찾을 수 없습니다.',
        ephemeral: true,
      });
    }

    // 관리 채널에 구매 요청 Embed 전송
    const requestEmbed = new EmbedBuilder()
      .setTitle('💳 새 멤버십 구매 요청')
      .addFields(
        { name: '👤 요청자', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
        { name: '🏷️ 티어', value: `${tier.name}`, inline: true },
        { name: '💰 금액', value: tier.price, inline: true },
        { name: '🎮 크레딧', value: `${tier.credits}회`, inline: true },
        {
          name: '✅ 충전 명령어',
          value: `\`/멤버십 충전 멤버:@${interaction.user.username} 횟수:${tier.credits}\``,
        }
      )
      .setColor(0xffa500)
      .setTimestamp()
      .setFooter({ text: '입금 확인 후 위 명령어로 크레딧을 충전해주세요' });

    await notifyChannel.send({ embeds: [requestEmbed] });

    // 유저에게 확인 메시지
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ 구매 요청 완료!')
          .setDescription(
            `**${tier.name}** (${tier.price} / ${tier.credits}회) 구매 요청이 접수되었습니다.\n\n` +
              '관리자가 입금을 확인하면 크레딧이 자동 충전됩니다.\n' +
              '`/멤버십 정보`로 크레딧 상태를 확인할 수 있습니다.'
          )
          .setColor(0x57f287),
      ],
      ephemeral: true,
    });
  },

  // ============================================
  // ➕ 크레딧 충전 (관리자)
  // ============================================
  async charge(interaction) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ 서버 관리 권한이 필요합니다.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('멤버');
    const amount = interaction.options.getInteger('횟수');

    // 티어 자동 판별
    let tierName = '커스텀';
    for (const [, t] of Object.entries(TIERS)) {
      if (t.credits === amount) {
        tierName = t.name;
        break;
      }
    }

    const result = chargeCredits(
      interaction.guild.id,
      targetUser.id,
      amount,
      tierName,
      interaction.user.id
    );

    const embed = new EmbedBuilder()
      .setTitle('✅ 크레딧 충전 완료!')
      .addFields(
        { name: '👤 대상', value: `<@${targetUser.id}>`, inline: true },
        { name: '➕ 충전', value: `${amount}회`, inline: true },
        { name: '💳 잔여', value: `${result.credits}회`, inline: true },
        { name: '📊 총 구매', value: `${result.totalPurchased}회`, inline: true }
      )
      .setColor(0x57f287)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },

  // ============================================
  // 📊 멤버십 정보
  // ============================================
  async info(interaction) {
    const targetUser = interaction.options.getUser('멤버') || interaction.user;
    const info = getMembershipInfo(interaction.guild.id, targetUser.id);

    if (!info) {
      return interaction.reply({
        content: `${targetUser.id === interaction.user.id ? '멤버십 정보가 없습니다' : `<@${targetUser.id}>님의 멤버십 정보가 없습니다`}. \`/멤버십 구매\`로 크레딧을 구매해주세요.`,
        ephemeral: true,
      });
    }

    // 최근 사용 내역 (최근 10개)
    const recentHistory = (info.history || [])
      .filter((h) => h.type === 'use')
      .slice(-10)
      .reverse()
      .map((h) => `• ${h.action} (${new Date(h.at).toLocaleDateString('ko-KR')})`)
      .join('\n') || '사용 내역 없음';

    const embed = new EmbedBuilder()
      .setTitle(`💳 ${targetUser.username}님의 멤버십 정보`)
      .addFields(
        { name: '🎮 잔여 크레딧', value: `**${info.credits}회**`, inline: true },
        { name: '📊 총 구매', value: `${info.totalPurchased}회`, inline: true },
        { name: '🏷️ 마지막 티어', value: info.tier || '없음', inline: true },
        { name: '📋 최근 사용 내역', value: recentHistory }
      )
      .setColor(info.credits > 0 ? 0x57f287 : 0xff0000)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },

  // ============================================
  // ⚙️ 알림 채널 설정 (관리자)
  // ============================================
  async setChannel(interaction) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ 서버 관리 권한이 필요합니다.', ephemeral: true });
    }

    const channel = interaction.options.getChannel('채널');
    setMembershipChannel(interaction.guild.id, channel.id);

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ 멤버십 관리 채널 설정 완료')
          .setDescription(
            `${channel}에 멤버십 구매 요청 알림이 전송됩니다.\n\n` +
              '멤버가 `/멤버십 구매`를 하면 이 채널에 요청이 올라옵니다.'
          )
          .setColor(0x57f287),
      ],
      ephemeral: true,
    });
  },
};
