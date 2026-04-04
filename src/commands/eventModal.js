const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const {
  createEvent,
  createEventEmbed,
} = require('../services/eventService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('빠른이벤트')
    .setDescription('모달 폼으로 이벤트를 빠르게 생성합니다'),

  async execute(interaction) {
    const modal = new ModalBuilder()
      .setCustomId('quick_event_modal')
      .setTitle('이벤트 생성');

    const titleInput = new TextInputBuilder()
      .setCustomId('event_title')
      .setLabel('이벤트 제목')
      .setPlaceholder('예: 내전 5vs5')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const dateInput = new TextInputBuilder()
      .setCustomId('event_date')
      .setLabel('날짜')
      .setPlaceholder('예: 2026-04-10')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(10);

    const timeInput = new TextInputBuilder()
      .setCustomId('event_time')
      .setLabel('시간')
      .setPlaceholder('예: 20:00')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(5);

    const descInput = new TextInputBuilder()
      .setCustomId('event_desc')
      .setLabel('설명 (선택)')
      .setPlaceholder('이벤트에 대한 추가 설명을 적어주세요')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(1000);

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(dateInput),
      new ActionRowBuilder().addComponents(timeInput),
      new ActionRowBuilder().addComponents(descInput),
    );

    await interaction.showModal(modal);
  },
};
