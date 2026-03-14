const { pool } = require('../db');
const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

// ============================================
// 🎮 게임 역할 목록 (ID 기반으로 안정적 매칭)
// ============================================
const GAME_ROLES = [
  { id: '1462734611527499838', name: 'LOL',      label: '🎮 League of Legends', emoji: '🎮' },
  { id: '1462734448901492843', name: 'valorant', label: '🔫 VALORANT',           emoji: '🔫' },
  { id: '1462734548008697856', name: 'apex',     label: '🏹 Apex Legends',       emoji: '🏹' },
  { id: '1462736830981210225', name: 'pubg',     label: '🪖 배틀그라운드',        emoji: '🪖' },
  { id: '1468235099454832774', name: 'rainbow6', label: '🛡️ Rainbow Six Siege', emoji: '🛡️' },
  { id: '1482258801242669137', name: 'tarkov',   label: '🔫 Escape from Tarkov', emoji: '🎯' },
];

// ============================================
// 📁 DB 설정 관리 (welcomeSettings)
// ============================================
async function getGuildSettings(guildId) {
  const { rows } = await pool.query(
    'SELECT * FROM welcome_settings WHERE guild_id = $1',
    [guildId]
  );
  return rows[0] || null;
}

async function updateGuildSettings(guildId, newSettings) {
  const { enabled, channel_id, message } = newSettings;
  await pool.query(
    `INSERT INTO welcome_settings (guild_id, enabled, channel_id, message)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (guild_id) DO UPDATE
     SET enabled = COALESCE($2, welcome_settings.enabled),
         channel_id = COALESCE($3, welcome_settings.channel_id),
         message = COALESCE($4, welcome_settings.message)`,
    [guildId, enabled ?? null, channel_id ?? null, message ?? null]
  );
  return getGuildSettings(guildId);
}

// ============================================
// 📝 템플릿 파싱
// ============================================
function parseTemplate(template, member) {
  return template
    .replace(/\{\{user\}\}/g, `${member}`)
    .replace(/\{\{username\}\}/g, member.displayName || member.user.username)
    .replace(/\{\{server\}\}/g, member.guild.name)
    .replace(/\{\{memberCount\}\}/g, member.guild.memberCount.toString());
}

// ============================================
// 🎮 게임 선택 셀렉트 메뉴 생성
// ============================================
function createGameSelectMenu() {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('game_select')
    .setPlaceholder('🎮 플레이하는 게임을 선택해주세요! (복수 선택 가능)')
    .setMinValues(0)
    .setMaxValues(GAME_ROLES.length)
    .addOptions(
      GAME_ROLES.map((game) => ({
        label: game.label,
        value: game.id,   // ← ID 기반으로 변경
        emoji: game.emoji,
      }))
    );

  return new ActionRowBuilder().addComponents(selectMenu);
}

// ============================================
// 👋 환영 임베드 생성
// ============================================
function createWelcomeEmbed(member, settings) {
  const defaultMessage =
    '{{user}}님, **{{server}}**에 오신 것을 환영합니다! 🎉\n아래에서 플레이하는 게임을 선택하면 해당 게임 채널에 입장할 수 있어요!';
  const message = settings?.message || defaultMessage;
  const parsedMessage = parseTemplate(message, member);

  return new EmbedBuilder()
    .setTitle('👋 환영합니다!')
    .setDescription(parsedMessage)
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .addFields(
      { name: '👤 멤버', value: member.user.tag, inline: true },
      { name: '👥 멤버 수', value: `${member.guild.memberCount}명`, inline: true },
      { name: '📅 가입일', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
      { name: '🎮 게임 채널', value: '아래에서 게임을 선택하면\n해당 카테고리가 보여요!', inline: false }
    )
    .setColor(0x57f287)
    .setFooter({ text: member.guild.name })
    .setTimestamp();
}

// ============================================
// 👋 멤버 입장 처리
// ============================================
async function handleMemberJoin(member) {
  let settings;
  try {
    settings = await getGuildSettings(member.guild.id);
  } catch (err) {
    console.error('환영 설정 로드 오류 (DB):', err.message);
    return;
  }

  if (!settings || !settings.enabled || !settings.channel_id) return;

  try {
    const channel = member.guild.channels.cache.get(settings.channel_id);
    if (!channel) {
      console.error(`환영 채널을 찾을 수 없음: ${settings.channel_id}`);
      return;
    }

    const embed   = createWelcomeEmbed(member, settings);
    const gameMenu = createGameSelectMenu();

    await channel.send({ embeds: [embed], components: [gameMenu] });
    console.log(`👋 환영 메시지 전송: ${member.user.tag} → ${member.guild.name}`);
  } catch (err) {
    console.error('환영 메시지 전송 오류:', err);
  }
}

// ============================================
// 🎮 게임 선택 처리 (role ID 기반)
// ============================================
async function handleGameSelect(interaction) {
  const selectedRoleIds = interaction.values; // 이제 role ID 배열
  const member = interaction.member;
  const guild  = interaction.guild;

  try {
    await interaction.deferReply({ ephemeral: true });

    const addedRoles   = [];
    const removedRoles = [];

    for (const game of GAME_ROLES) {
      const role = guild.roles.cache.get(game.id);
      if (!role) continue;

      if (selectedRoleIds.includes(game.id)) {
        if (!member.roles.cache.has(game.id)) {
          await member.roles.add(role);
        }
        addedRoles.push(game.label);
      } else {
        if (member.roles.cache.has(game.id)) {
          await member.roles.remove(role);
          removedRoles.push(game.label);
        }
      }
    }

    const embed = new EmbedBuilder().setColor(0x5865f2).setTimestamp();

    if (addedRoles.length > 0) {
      embed
        .setTitle('🎮 게임 역할이 설정되었습니다!')
        .setDescription(
          addedRoles.map(r => `✅ ${r}`).join('\n') +
          (removedRoles.length > 0 ? '\n\n' + removedRoles.map(r => `❌ ${r} (해제)`).join('\n') : '')
        )
        .addFields({ name: '💡 TIP', value: '선택한 게임 카테고리 채널이 이제 보여요!' });
    } else {
      embed
        .setTitle('🎮 게임 역할이 모두 해제되었습니다')
        .setDescription('다시 선택하려면 셀렉트 메뉴를 사용해주세요.');
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('게임 선택 처리 오류:', err);
    const errorMsg = '❌ 게임 역할 설정 중 오류가 발생했습니다.';
    if (interaction.deferred) {
      await interaction.editReply({ content: errorMsg });
    } else {
      await interaction.reply({ content: errorMsg, ephemeral: true });
    }
  }
}

module.exports = {
  GAME_ROLES,
  getGuildSettings,
  updateGuildSettings,
  createWelcomeEmbed,
  createGameSelectMenu,
  handleMemberJoin,
  handleGameSelect,
};
