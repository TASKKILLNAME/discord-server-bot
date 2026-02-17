const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  EmbedBuilder,
} = require('discord.js');
const templates = require('../templates/serverTemplates');
const {
  clearServer,
  createRoles,
  createChannels,
  sleep,
} = require('../utils/serverSetup');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('서버구성')
    .setDescription('서버를 템플릿으로 자동 구성합니다')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    // 템플릿 선택 메뉴
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('template_select')
      .setPlaceholder('서버 템플릿을 선택하세요')
      .addOptions(
        Object.entries(templates).map(([key, template]) => ({
          label: template.name,
          description: template.description,
          value: key,
        }))
      );

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const embed = new EmbedBuilder()
      .setTitle('🛠️ 서버 자동 구성')
      .setDescription(
        '원하는 서버 템플릿을 선택하세요!\n\n' +
          Object.entries(templates)
            .map(
              ([, t]) =>
                `**${t.name}**\n${t.description}\n📁 ${t.categories.length}개 카테고리 | 👤 ${t.roles.length}개 역할`
            )
            .join('\n\n')
      )
      .setColor('#5865F2')
      .setFooter({ text: '⚠️ 기존 채널/역할은 유지됩니다' });

    await interaction.reply({
      embeds: [embed],
      components: [row],
      ephemeral: true,
    });
  },

  // 셀렉트 메뉴 핸들러
  async handleSelect(interaction) {
    const templateKey = interaction.values[0];
    const template = templates[templateKey];

    // 확인 버튼
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_setup_${templateKey}`)
        .setLabel('✅ 구성 시작')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`confirm_setup_clear_${templateKey}`)
        .setLabel('🗑️ 초기화 후 구성')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('cancel_setup')
        .setLabel('❌ 취소')
        .setStyle(ButtonStyle.Secondary)
    );

    const previewEmbed = new EmbedBuilder()
      .setTitle(`${template.name} 미리보기`)
      .addFields(
        {
          name: '👤 생성될 역할',
          value: template.roles.map((r) => r.name).join('\n'),
          inline: true,
        },
        {
          name: '📁 생성될 카테고리',
          value: template.categories.map((c) => c.name).join('\n'),
          inline: true,
        },
        {
          name: '📝 총 채널 수',
          value: `${template.categories.reduce((acc, c) => acc + c.channels.length, 0)}개`,
          inline: true,
        }
      )
      .setColor('#FFA500')
      .setFooter({ text: '⚠️ "초기화 후 구성"은 기존 채널을 모두 삭제합니다!' });

    await interaction.update({
      embeds: [previewEmbed],
      components: [confirmRow],
    });
  },

  // 확인 버튼 핸들러
  async handleConfirm(interaction) {
    const customId = interaction.customId;
    const shouldClear = customId.includes('clear');
    const templateKey = customId.replace('confirm_setup_clear_', '').replace('confirm_setup_', '');
    const template = templates[templateKey];

    if (!template) {
      return interaction.update({
        content: '❌ 템플릿을 찾을 수 없습니다.',
        embeds: [],
        components: [],
      });
    }

    const guild = interaction.guild;

    // 진행 상황 표시
    const progressEmbed = new EmbedBuilder()
      .setTitle('⏳ 서버 구성 중...')
      .setDescription('잠시만 기다려주세요...')
      .setColor('#FFA500');

    await interaction.update({
      embeds: [progressEmbed],
      components: [],
    });

    try {
      let statusLog = [];

      // 1. 기존 채널 삭제 (선택 시)
      if (shouldClear) {
        statusLog.push('🗑️ 기존 채널 삭제 중...');
        await clearServer(guild);
        statusLog.push('✅ 기존 채널 삭제 완료');
        await sleep(1000);
      }

      // 2. 역할 생성
      statusLog.push('👤 역할 생성 중...');
      const createdRoles = await createRoles(guild, template.roles);
      statusLog.push(`✅ ${Object.keys(createdRoles).length}개 역할 생성 완료`);

      // 3. 채널 생성
      statusLog.push('📝 채널 생성 중...');
      const createdChannels = await createChannels(
        guild,
        template.categories,
        createdRoles
      );
      statusLog.push(
        `✅ ${Object.keys(createdChannels).length}개 채널 생성 완료`
      );

      // 완료 임베드
      const completeEmbed = new EmbedBuilder()
        .setTitle('✅ 서버 구성 완료!')
        .setDescription(
          `**${template.name}** 템플릿으로 서버가 구성되었습니다!\n\n` +
            statusLog.join('\n')
        )
        .addFields(
          {
            name: '👤 생성된 역할',
            value: Object.keys(createdRoles).join(', ') || '없음',
          },
          {
            name: '📝 생성된 채널',
            value: `${Object.keys(createdChannels).length}개`,
          }
        )
        .setColor('#00FF00')
        .setTimestamp();

      // 원래 채널이 삭제되었을 수 있으므로 첫 번째 텍스트 채널에 메시지 전송
      if (shouldClear) {
        const firstTextChannel = guild.channels.cache.find(
          (c) => c.type === 0
        );
        if (firstTextChannel) {
          await firstTextChannel.send({ embeds: [completeEmbed] });
        }
      } else {
        await interaction.editReply({ embeds: [completeEmbed], components: [] });
      }
    } catch (err) {
      console.error('서버 구성 실패:', err);
      const errorEmbed = new EmbedBuilder()
        .setTitle('❌ 서버 구성 실패')
        .setDescription(`오류가 발생했습니다: ${err.message}`)
        .setColor('#FF0000');

      try {
        await interaction.editReply({ embeds: [errorEmbed], components: [] });
      } catch {
        const fallbackChannel = guild.channels.cache.find((c) => c.type === 0);
        if (fallbackChannel) {
          await fallbackChannel.send({ embeds: [errorEmbed] });
        }
      }
    }
  },
};