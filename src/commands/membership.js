const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
} = require('discord.js');
const {
  TIERS,
  getCredits,
  getMembershipInfo,
  chargeCredits,
} = require('../services/membershipService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('멤버십')
    .setDescription('AI 분석 크레딧 멤버십')
    .addSubcommand((sub) =>
      sub.setName('구매').setDescription('AI 분석 크레딧을 구매합니다')
    )
    .addSubcommand((sub) =>
      sub
        .setName('정보')
        .setDescription('멤버십 정보를 확인합니다')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case '구매':
        return this.purchase(interaction);
      case '정보':
        return this.info(interaction);
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
  // 🔘 버튼 핸들러 (구매/승인/거절)
  // ============================================
  async handleButton(interaction) {
    const customId = interaction.customId;

    // ✅ 승인 버튼 (DM에서)
    if (customId.startsWith('membership_approve_')) {
      return this.handleApprove(interaction);
    }

    // ❌ 거절 버튼 (DM에서)
    if (customId.startsWith('membership_reject_')) {
      return this.handleReject(interaction);
    }

    // 🛒 구매 티어 버튼 (서버에서)
    if (customId.startsWith('membership_buy_')) {
      return this.handleBuy(interaction);
    }

    return interaction.reply({ content: '❌ 알 수 없는 요청입니다.', ephemeral: true });
  },

  // ============================================
  // 🛒 구매 티어 선택 → 봇 오너에게 DM
  // ============================================
  async handleBuy(interaction) {
    const tierKey = interaction.customId.replace('membership_buy_', '');
    const tier = TIERS[tierKey];

    if (!tier) {
      return interaction.reply({ content: '❌ 알 수 없는 티어입니다.', ephemeral: true });
    }

    const ownerId = process.env.BOT_OWNER_ID;
    if (!ownerId) {
      return interaction.reply({
        content: '❌ 봇 관리자 설정이 되어있지 않습니다. 관리자에게 문의해주세요.',
        ephemeral: true,
      });
    }

    try {
      const owner = await interaction.client.users.fetch(ownerId);

      const requestEmbed = new EmbedBuilder()
        .setTitle('💳 새 멤버십 구매 요청')
        .addFields(
          { name: '🏠 서버', value: `${interaction.guild.name} (${interaction.guild.id})`, inline: false },
          { name: '👤 요청자', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
          { name: '🏷️ 티어', value: `${tier.name}`, inline: true },
          { name: '💰 금액', value: tier.price, inline: true },
          { name: '🎮 크레딧', value: `${tier.credits}회`, inline: true }
        )
        .setColor(0xffa500)
        .setTimestamp()
        .setFooter({ text: '입금 확인 후 승인 버튼을 눌러주세요' });

      // 승인/거절 버튼
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`membership_approve_${interaction.guild.id}_${interaction.user.id}_${tierKey}`)
          .setLabel('✅ 승인')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`membership_reject_${interaction.guild.id}_${interaction.user.id}`)
          .setLabel('❌ 거절')
          .setStyle(ButtonStyle.Danger)
      );

      await owner.send({ embeds: [requestEmbed], components: [row] });
    } catch (err) {
      console.error('봇 오너 DM 전송 실패:', err.message);
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ 구매 요청 완료!')
          .setDescription(
            `**${tier.name}** (${tier.price} / ${tier.credits}회) 구매 요청이 접수되었습니다.\n\n` +
              '관리자가 입금을 확인하면 크레딧이 충전됩니다.\n' +
              '`/멤버십 정보`로 크레딧 상태를 확인할 수 있습니다.'
          )
          .setColor(0x57f287),
      ],
      ephemeral: true,
    });
  },

  // ============================================
  // ✅ 승인 처리 (봇 오너 DM에서)
  // ============================================
  async handleApprove(interaction) {
    // customId: membership_approve_{guildId}_{userId}_{tierKey}
    const parts = interaction.customId.replace('membership_approve_', '').split('_');
    const guildId = parts[0];
    const userId = parts[1];
    const tierKey = parts[2];
    const tier = TIERS[tierKey];

    if (!tier) {
      return interaction.reply({ content: '❌ 티어 정보를 찾을 수 없습니다.', ephemeral: true });
    }

    // 크레딧 충전
    const result = chargeCredits(guildId, userId, tier.credits, tier.name, interaction.user.id);

    // 유저에게 DM 알림
    try {
      const targetUser = await interaction.client.users.fetch(userId);
      const guild = interaction.client.guilds.cache.get(guildId);
      const serverName = guild?.name || '서버';

      await targetUser.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ 크레딧 충전 완료!')
            .setDescription(
              `**${serverName}**에서의 멤버십 구매가 승인되었습니다!\n\n` +
                `🏷️ 티어: ${tier.name}\n` +
                `➕ 충전: ${tier.credits}회\n` +
                `💳 잔여 크레딧: **${result.credits}회**\n\n` +
                '`/멤버십 정보`로 확인할 수 있습니다.'
            )
            .setColor(0x57f287)
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('유저 DM 전송 실패:', err.message);
    }

    // 원래 DM 메시지의 버튼 비활성화 + 승인 완료 표시
    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0x57f287)
      .setFooter({ text: `✅ 승인 완료 — ${new Date().toLocaleString('ko-KR')}` });

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('membership_done_approve')
        .setLabel('✅ 승인 완료')
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('membership_done_reject')
        .setLabel('❌ 거절')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );

    await interaction.update({ embeds: [updatedEmbed], components: [disabledRow] });
  },

  // ============================================
  // ❌ 거절 처리 (봇 오너 DM에서)
  // ============================================
  async handleReject(interaction) {
    // customId: membership_reject_{guildId}_{userId}
    const parts = interaction.customId.replace('membership_reject_', '').split('_');
    const guildId = parts[0];
    const userId = parts[1];

    // 유저에게 DM 알림
    try {
      const targetUser = await interaction.client.users.fetch(userId);
      const guild = interaction.client.guilds.cache.get(guildId);
      const serverName = guild?.name || '서버';

      await targetUser.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ 구매 요청 거절')
            .setDescription(
              `**${serverName}**에서의 멤버십 구매 요청이 거절되었습니다.\n\n` +
                '입금이 확인되지 않았거나 문제가 있을 수 있습니다.\n' +
                '관리자에게 문의해주세요.'
            )
            .setColor(0xed4245)
            .setTimestamp(),
        ],
      });
    } catch (err) {
      console.error('유저 DM 전송 실패:', err.message);
    }

    // 원래 DM 메시지의 버튼 비활성화 + 거절 표시
    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(0xed4245)
      .setFooter({ text: `❌ 거절됨 — ${new Date().toLocaleString('ko-KR')}` });

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('membership_done_approve')
        .setLabel('✅ 승인')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('membership_done_reject')
        .setLabel('❌ 거절됨')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true)
    );

    await interaction.update({ embeds: [updatedEmbed], components: [disabledRow] });
  },

  // ============================================
  // 📊 멤버십 정보
  // ============================================
  async info(interaction) {
    const info = getMembershipInfo(interaction.guild.id, interaction.user.id);

    if (!info) {
      return interaction.reply({
        content: '멤버십 정보가 없습니다. `/멤버십 구매`로 크레딧을 구매해주세요.',
        ephemeral: true,
      });
    }

    const recentHistory = (info.history || [])
      .filter((h) => h.type === 'use')
      .slice(-10)
      .reverse()
      .map((h) => `• ${h.action} (${new Date(h.at).toLocaleDateString('ko-KR')})`)
      .join('\n') || '사용 내역 없음';

    const embed = new EmbedBuilder()
      .setTitle(`💳 ${interaction.user.username}님의 멤버십 정보`)
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
};
