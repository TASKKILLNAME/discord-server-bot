const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require('discord.js');
const { getProfile, upsertProfile, deleteProfile, getRanking } = require('../services/limbusService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('림버스')
    .setDescription('림버스 컴퍼니 진척도 추적')
    .addSubcommand((sub) =>
      sub.setName('등록').setDescription('진척도를 등록/수정합니다 (모달 입력)')
    )
    .addSubcommand((sub) =>
      sub
        .setName('조회')
        .setDescription('진척도를 조회합니다')
        .addUserOption((opt) =>
          opt.setName('멤버').setDescription('조회할 멤버 (기본: 본인)')
        )
    )
    .addSubcommand((sub) =>
      sub.setName('랭킹').setDescription('서버 내 림버스 진척도 랭킹')
    )
    .addSubcommand((sub) =>
      sub.setName('삭제').setDescription('내 진척도 데이터를 삭제합니다')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case '등록': return this.register(interaction);
      case '조회': return this.view(interaction);
      case '랭킹': return this.ranking(interaction);
      case '삭제': return this.remove(interaction);
    }
  },

  // ── 등록/수정 (모달) ──
  async register(interaction) {
    const existing = await getProfile(interaction.guild.id, interaction.user.id);

    const modal = new ModalBuilder()
      .setCustomId('limbus_profile_modal')
      .setTitle('림버스 진척도 등록');

    const chapterInput = new TextInputBuilder()
      .setCustomId('story_chapter')
      .setLabel('스토리 챕터 (숫자)')
      .setPlaceholder('예: 7')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(3)
      .setValue(existing?.story_chapter?.toString() || '');

    const mirrorInput = new TextInputBuilder()
      .setCustomId('mirror_floor')
      .setLabel('거울 던전 클리어 층수 (숫자)')
      .setPlaceholder('예: 5')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(3)
      .setValue(existing?.mirror_floor?.toString() || '');

    const countsInput = new TextInputBuilder()
      .setCustomId('counts')
      .setLabel('보유 인격 수 / EGO 수 / 레벨 (슬래시 구분)')
      .setPlaceholder('예: 85 / 42 / 55')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(30)
      .setValue(
        existing
          ? `${existing.identity_count || 0} / ${existing.ego_count || 0} / ${existing.level || 1}`
          : ''
      );

    const mainInput = new TextInputBuilder()
      .setCustomId('main_info')
      .setLabel('주력 수감자 / 인격 (슬래시 구분)')
      .setPlaceholder('예: 이상 / R사 4과 이상')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(100)
      .setValue(
        existing?.main_sinner
          ? `${existing.main_sinner}${existing.main_identity ? ' / ' + existing.main_identity : ''}`
          : ''
      );

    const noteInput = new TextInputBuilder()
      .setCustomId('note')
      .setLabel('메모 (자유)')
      .setPlaceholder('현재 목표, 하고 싶은 말 등')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(200)
      .setValue(existing?.note || '');

    modal.addComponents(
      new ActionRowBuilder().addComponents(chapterInput),
      new ActionRowBuilder().addComponents(mirrorInput),
      new ActionRowBuilder().addComponents(countsInput),
      new ActionRowBuilder().addComponents(mainInput),
      new ActionRowBuilder().addComponents(noteInput),
    );

    await interaction.showModal(modal);
  },

  // ── 조회 ──
  async view(interaction) {
    const targetUser = interaction.options.getUser('멤버') || interaction.user;
    const profile = await getProfile(interaction.guild.id, targetUser.id);

    if (!profile) {
      return interaction.reply({
        content: targetUser.id === interaction.user.id
          ? '❌ 등록된 진척도가 없습니다. `/림버스 등록`으로 등록해주세요.'
          : `❌ <@${targetUser.id}>님의 등록된 진척도가 없습니다.`,
        ephemeral: true,
      });
    }

    const layout = buildProfileLayout(profile, targetUser);
    await interaction.reply({ components: layout.components, flags: layout.flags });
  },

  // ── 랭킹 ──
  async ranking(interaction) {
    const profiles = await getRanking(interaction.guild.id);

    if (profiles.length === 0) {
      return interaction.reply({
        content: '❌ 등록된 유저가 없습니다. `/림버스 등록`으로 시작하세요!',
        ephemeral: true,
      });
    }

    const container = new ContainerBuilder().setAccentColor(0xe63946);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## 🔥 림버스 컴퍼니 랭킹'),
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );

    const medals = ['🥇', '🥈', '🥉'];
    const lines = profiles.slice(0, 15).map((p, i) => {
      const medal = medals[i] || `**${i + 1}.**`;
      const chapter = p.story_chapter ? `📖${p.story_chapter}장` : '';
      const mirror = p.mirror_floor ? `🪞${p.mirror_floor}층` : '';
      const ids = p.identity_count ? `👤${p.identity_count}` : '';
      const ego = p.ego_count ? `🧿${p.ego_count}` : '';
      const lv = p.level ? `Lv.${p.level}` : '';
      const main = p.main_sinner ? `(${p.main_sinner})` : '';

      const stats = [chapter, mirror, ids, ego, lv].filter(Boolean).join('　');
      return `${medal} <@${p.user_id}> ${main}\n┗ ${stats}`;
    });

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join('\n\n')),
    );

    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 총 ${profiles.length}명 등록`),
    );

    await interaction.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  },

  // ── 삭제 ──
  async remove(interaction) {
    const deleted = await deleteProfile(interaction.guild.id, interaction.user.id);
    await interaction.reply({
      content: deleted
        ? '✅ 림버스 진척도가 삭제되었습니다.'
        : '❌ 등록된 데이터가 없습니다.',
      ephemeral: true,
    });
  },
};

// ── Components V2 프로필 레이아웃 ──
function buildProfileLayout(profile, user) {
  const container = new ContainerBuilder().setAccentColor(0xe63946);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🔥 ${user.displayName}의 림버스 진척도`
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  // 스탯
  const statLines = [];
  if (profile.level) statLines.push(`**레벨:** ${profile.level}`);
  if (profile.story_chapter) statLines.push(`**스토리:** ${profile.story_chapter}장`);
  if (profile.mirror_floor) statLines.push(`**거울 던전:** ${profile.mirror_floor}층`);
  if (profile.identity_count) statLines.push(`**보유 인격:** ${profile.identity_count}개`);
  if (profile.ego_count) statLines.push(`**보유 EGO:** ${profile.ego_count}개`);

  if (statLines.length > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(statLines.join('\n')),
    );
  }

  // 주력 정보
  if (profile.main_sinner || profile.main_identity) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );

    const mainLines = [];
    if (profile.main_sinner) mainLines.push(`**주력 수감자:** ${profile.main_sinner}`);
    if (profile.main_identity) mainLines.push(`**주력 인격:** ${profile.main_identity}`);

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(mainLines.join('\n')),
    );
  }

  // 메모
  if (profile.note) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
    );

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**메모:** ${profile.note}`),
    );
  }

  // 업데이트 시간
  const updatedAt = new Date(profile.updated_at);
  const ts = Math.floor(updatedAt.getTime() / 1000);

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`-# 마지막 업데이트: <t:${ts}:R>`),
  );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
  };
}
