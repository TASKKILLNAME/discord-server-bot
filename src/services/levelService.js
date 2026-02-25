const { pool } = require('../db');
const { EmbedBuilder } = require('discord.js');

// ============================================
// ⚙️ XP 설정
// ============================================
const XP_MIN      = 15;
const XP_MAX      = 25;
const XP_COOLDOWN = 60 * 1000; // 60초

// ============================================
// 📊 레벨 계산
// ============================================
function calculateLevel(xp) {
  return Math.floor(0.1 * Math.sqrt(xp));
}

function xpForLevel(level) {
  return (level * 10) ** 2;
}

function xpForNextLevel(level) {
  return xpForLevel(level + 1);
}

// ============================================
// ✨ XP 처리 (async)
// ============================================
async function addXp(guildId, userId) {
  // 유저 데이터 가져오기 (없으면 INSERT)
  const { rows } = await pool.query(
    `INSERT INTO levels (guild_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id, user_id) DO NOTHING
     RETURNING *;`,
    [guildId, userId]
  );

  // 현재 데이터 조회
  const { rows: [userData] } = await pool.query(
    `SELECT * FROM levels WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  const now = Date.now();

  // 💬 메시지 카운트 증가
  await pool.query(
    `UPDATE levels SET message_count = message_count + 1
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  // ⏰ 쿨다운 체크
  if (now - Number(userData.last_xp_time) < XP_COOLDOWN) {
    return { leveledUp: false, userData };
  }

  // ✨ XP 부여
  const xpGain   = Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
  const newXp    = userData.xp + xpGain;
  const newLevel = calculateLevel(newXp);
  const leveledUp = newLevel > userData.level;

  await pool.query(
    `UPDATE levels
     SET xp = $3, level = $4, last_xp_time = $5
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId, newXp, newLevel, now]
  );

  return { leveledUp, newLevel, xpGain, userData: { ...userData, xp: newXp, level: newLevel } };
}

// ============================================
// 🔍 조회 함수 (async)
// ============================================
async function getUserData(guildId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM levels WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );
  if (rows.length === 0) return { xp: 0, level: 0, messageCount: 0, lastXpTime: 0 };
  const r = rows[0];
  return {
    xp:           r.xp,
    level:        r.level,
    messageCount: r.message_count,
    lastXpTime:   Number(r.last_xp_time),
  };
}

async function getLeaderboard(guildId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM levels
     WHERE guild_id = $1
     ORDER BY xp DESC
     LIMIT $2`,
    [guildId, limit]
  );
  // 컬럼명 snake_case → camelCase 변환 (기존 코드 호환)
  return rows.map(r => ({
    userId:       r.user_id,
    xp:           r.xp,
    level:        r.level,
    messageCount: r.message_count,
    lastXpTime:   r.last_xp_time,
  }));
}

async function getUserRank(guildId, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) + 1 AS rank
     FROM levels
     WHERE guild_id = $1 AND xp > (
       SELECT COALESCE(xp, 0) FROM levels WHERE guild_id = $1 AND user_id = $2
     )`,
    [guildId, userId]
  );
  return Number(rows[0].rank);
}

// ============================================
// 🎉 레벨업 Embed 생성
// ============================================
function createLevelUpEmbed(member, newLevel) {
  return new EmbedBuilder()
    .setTitle('🎉 레벨 업!')
    .setDescription(`축하합니다! ${member}님이 **레벨 ${newLevel}**에 도달했습니다!`)
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setColor(0xffd700)
    .setTimestamp();
}

module.exports = {
  calculateLevel,
  xpForLevel,
  xpForNextLevel,
  addXp,
  getUserData,
  getLeaderboard,
  getUserRank,
  createLevelUpEmbed,
};
