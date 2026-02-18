const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');

const DATA_FILE = path.join(__dirname, '../../data/levels.json');

// ============================================
// ⚙️ XP 설정
// ============================================
const XP_MIN = 15;
const XP_MAX = 25;
const XP_COOLDOWN = 60 * 1000; // 60초

// ============================================
// 📁 데이터 관리
// ============================================
function loadLevels() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('레벨 데이터 로드 오류:', err);
  }
  return {};
}

function saveLevels(data) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('레벨 데이터 저장 오류:', err);
  }
}

// ============================================
// 📊 레벨 계산
// ============================================
function calculateLevel(xp) {
  return Math.floor(0.1 * Math.sqrt(xp));
}

function xpForLevel(level) {
  // level = 0.1 * sqrt(xp) → xp = (level / 0.1)^2 = (level * 10)^2
  return (level * 10) ** 2;
}

function xpForNextLevel(currentLevel) {
  return xpForLevel(currentLevel + 1);
}

// ============================================
// ✨ XP 처리
// ============================================
function addXp(guildId, userId) {
  const data = loadLevels();

  // 길드 데이터 초기화
  if (!data[guildId]) data[guildId] = {};

  // 유저 데이터 초기화
  if (!data[guildId][userId]) {
    data[guildId][userId] = {
      xp: 0,
      level: 0,
      messageCount: 0,
      lastXpTime: 0,
    };
  }

  const userData = data[guildId][userId];
  const now = Date.now();

  // 💬 메시지 카운트는 항상 증가
  userData.messageCount++;

  // ⏰ 쿨다운 체크
  if (now - userData.lastXpTime < XP_COOLDOWN) {
    saveLevels(data);
    return { leveledUp: false, userData };
  }

  // ✨ XP 부여 (15~25 랜덤)
  const xpGain = Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
  userData.xp += xpGain;
  userData.lastXpTime = now;

  // 📊 레벨 계산
  const newLevel = calculateLevel(userData.xp);
  const leveledUp = newLevel > userData.level;
  userData.level = newLevel;

  saveLevels(data);

  return { leveledUp, newLevel, xpGain, userData };
}

// ============================================
// 🔍 조회 함수
// ============================================
function getUserData(guildId, userId) {
  const data = loadLevels();
  return (
    data[guildId]?.[userId] || {
      xp: 0,
      level: 0,
      messageCount: 0,
      lastXpTime: 0,
    }
  );
}

function getLeaderboard(guildId, limit = 10) {
  const data = loadLevels();
  const guildData = data[guildId] || {};

  return Object.entries(guildData)
    .map(([userId, userData]) => ({ userId, ...userData }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, limit);
}

function getUserRank(guildId, userId) {
  const data = loadLevels();
  const guildData = data[guildId] || {};

  const sorted = Object.entries(guildData)
    .map(([uid, udata]) => ({ userId: uid, ...udata }))
    .sort((a, b) => b.xp - a.xp);

  const rank = sorted.findIndex((u) => u.userId === userId) + 1;
  return rank || sorted.length + 1;
}

// ============================================
// 🎉 레벨업 Embed 생성
// ============================================
function createLevelUpEmbed(member, newLevel) {
  return new EmbedBuilder()
    .setTitle('🎉 레벨 업!')
    .setDescription(
      `축하합니다! ${member}님이 **레벨 ${newLevel}**에 도달했습니다!`
    )
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setColor(0xffd700)
    .setTimestamp();
}

module.exports = {
  loadLevels,
  saveLevels,
  calculateLevel,
  xpForLevel,
  xpForNextLevel,
  addXp,
  getUserData,
  getLeaderboard,
  getUserRank,
  createLevelUpEmbed,
};
