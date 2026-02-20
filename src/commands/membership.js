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
  // 🔘 버튼 핸들러 (봇 오너에게 DM으로 구매 요청)
  // ============================================
  async handleButton(interaction) {
    const tierKey = interaction.customId.replace('membership_buy_', '');
    const tier = TIERS[tierKey];

    if (!tier) {
      return interaction.reply({ content: '❌ 알 수 없는 티어입니다.', ephemeral: true });
    }

    // 봇 오너에게 DM 전송
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
        .setFooter({ text: '웹 대시보드에서 크레딧을 충전해주세요' });

      await owner.send({ embeds: [requestEmbed] });
    } catch (err) {
      console.error('봇 오너 DM 전송 실패:', err.message);
      // DM 실패해도 구매 요청은 접수된 것으로 처리
    }

    // 유저에게 확인 메시지
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

    // 최근 사용 내역 (최근 10개)
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
