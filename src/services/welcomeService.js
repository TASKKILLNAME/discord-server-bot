const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const DATA_FILE = path.join(__dirname, '../../data/welcomeSettings.json');

// ============================================
// 🎮 게임 역할 목록
// ============================================
const GAME_ROLES = [
  { name: 'LOL', label: '🎮 League of Legends', emoji: '🎮', color: '#C8AA6E' },
  { name: 'VALORANT', label: '🔫 VALORANT', emoji: '🔫', color: '#FF4655' },
  { name: 'PUBG', label: '🪖 배틀그라운드', emoji: '🪖', color: '#F2A900' },
  { name: 'Rainbow6', label: '🛡️ Rainbow Six Siege', emoji: '🛡️', color: '#2E6EA5' },
  { name: 'Apex', label: '🏹 Apex Legends', emoji: '🏹', color: '#DA292A' },
];

// ============================================
// 📁 데이터 관리
// ============================================
function loadWelcomeSettings() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('환영 설정 로드 오류:', err);
  }
  return {};
}

function saveWelcomeSettings(settings) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('환영 설정 저장 오류:', err);
  }
}

function getGuildSettings(guildId) {
  const settings = loadWelcomeSettings();
  return settings[guildId] || null;
}

function updateGuildSettings(guildId, newSettings) {
  const settings = loadWelcomeSettings();
  settings[guildId] = { ...settings[guildId], ...newSettings };
  saveWelcomeSettings(settings);
  return settings[guildId];
}

// ============================================
// 🎮 게임 역할 자동 생성
// ============================================
async function ensureGameRoles(guild) {
  const existingRoles = guild.roles.cache;
  const createdRoles = [];

  for (const game of GAME_ROLES) {
    const existing = existingRoles.find((r) => r.name === game.name);
    if (!existing) {
      try {
        const role = await guild.roles.create({
          name: game.name,
          color: game.color,
          reason: '환영 시스템 - 게임 역할 자동 생성',
        });
        createdRoles.push(role.name);
        console.log(`🎮 게임 역할 생성: ${role.name} (${guild.name})`);
      } catch (err) {
        console.error(`게임 역할 생성 실패 (${game.name}):`, err);
      }
    }
  }

  return createdRoles;
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
    .setPlaceholder('🎮 플레이하는 게임을 선택해주세요!')
    .setMinValues(0)
    .setMaxValues(GAME_ROLES.length)
    .addOptions(
      GAME_ROLES.map((game) => ({
        label: game.label,
        value: game.name,
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
    '{{user}}님, **{{server}}**에 오신 것을 환영합니다! 🎉\n아래에서 플레이하는 게임을 선택해주세요!';
  const message = settings?.message || defaultMessage;
  const parsedMessage = parseTemplate(message, member);

  return new EmbedBuilder()
    .setTitle('👋 환영합니다!')
    .setDescription(parsedMessage)
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .addFields(
      { name: '👤 멤버', value: member.user.tag, inline: true },
      { name: '👥 멤버 수', value: `${member.guild.memberCount}명`, inline: true },
      {
        name: '📅 가입일',
        value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`,
        inline: true,
      }
    )
    .setColor(0x57f287)
    .setFooter({ text: member.guild.name })
    .setTimestamp();
}

// ============================================
// 👋 멤버 입장 처리
// ============================================
async function handleMemberJoin(member) {
  const settings = getGuildSettings(member.guild.id);

  if (!settings || !settings.enabled || !settings.channelId) return;

  try {
    // 🎮 게임 역할 확인/생성
    await ensureGameRoles(member.guild);

    const channel = member.guild.channels.cache.get(settings.channelId);
    if (!channel) {
      console.error(`환영 채널을 찾을 수 없음: ${settings.channelId}`);
      return;
    }

    const embed = createWelcomeEmbed(member, settings);
    const gameMenu = createGameSelectMenu();

    await channel.send({
      embeds: [embed],
      components: [gameMenu],
    });

    console.log(`👋 환영 메시지 전송: ${member.user.tag} → ${member.guild.name}`);
  } catch (err) {
    console.error('환영 메시지 전송 오류:', err);
  }
}

// ============================================
// 🎮 게임 선택 처리
// ============================================
async function handleGameSelect(interaction) {
  const selectedGames = interaction.values;
  const member = interaction.member;
  const guild = interaction.guild;

  try {
    await interaction.deferReply({ ephemeral: true });

    // 🎮 게임 역할 확인/생성
    await ensureGameRoles(guild);

    const addedRoles = [];
    const removedRoles = [];

    for (const game of GAME_ROLES) {
      const role = guild.roles.cache.find((r) => r.name === game.name);
      if (!role) continue;

      if (selectedGames.includes(game.name)) {
        // 선택한 게임 → 역할 부여
        if (!member.roles.cache.has(role.id)) {
          await member.roles.add(role);
          addedRoles.push(game.label);
        } else {
          addedRoles.push(game.label); // 이미 있어도 표시
        }
      } else {
        // 선택 안 한 게임 → 역할 제거
        if (member.roles.cache.has(role.id)) {
          await member.roles.remove(role);
          removedRoles.push(game.label);
        }
      }
    }

    const embed = new EmbedBuilder().setColor(0x5865f2).setTimestamp();

    if (selectedGames.length > 0) {
      embed
        .setTitle('🎮 게임 역할이 설정되었습니다!')
        .setDescription(addedRoles.map((r) => `✅ ${r}`).join('\n'));
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
  loadWelcomeSettings,
  saveWelcomeSettings,
  getGuildSettings,
  updateGuildSettings,
  ensureGameRoles,
  createWelcomeEmbed,
  createGameSelectMenu,
  handleMemberJoin,
  handleGameSelect,
};
