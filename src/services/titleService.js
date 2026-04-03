const { pool } = require('../db');

/**
 * 칭호 부여
 */
async function setTitle(guildId, userId, title, adminId, originalNick) {
  await pool.query(
    `INSERT INTO titles (guild_id, user_id, title, original_nick, set_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (guild_id, user_id) DO UPDATE
     SET title = $3, set_by = $5, set_at = NOW()`,
    [guildId, userId, title, originalNick, adminId]
  );
}

/**
 * 칭호 해제
 */
async function removeTitle(guildId, userId) {
  const { rows } = await pool.query(
    'DELETE FROM titles WHERE guild_id = $1 AND user_id = $2 RETURNING *',
    [guildId, userId]
  );
  return rows[0] || null;
}

/**
 * 유저 칭호 조회
 */
async function getTitle(guildId, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM titles WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId]
  );
  return rows[0] || null;
}

/**
 * 서버 전체 칭호 목록
 */
async function getAllTitles(guildId) {
  const { rows } = await pool.query(
    'SELECT * FROM titles WHERE guild_id = $1 ORDER BY set_at DESC',
    [guildId]
  );
  return rows;
}

/**
 * 멤버 닉네임에 칭호 적용
 */
async function applyTitle(member, title) {
  const baseName = member.user.displayName; // 글로벌 표시 이름
  const currentNick = member.nickname || baseName;

  // 기존 칭호 제거 (이미 [xxx] 형태가 있으면)
  const cleanName = currentNick.replace(/^\[.+?\]\s*/, '').trim();
  const newNick = `[${title}] ${cleanName}`;

  // 닉네임 32자 제한
  if (newNick.length > 32) {
    const maxNameLen = 32 - title.length - 3; // [] + space
    const truncated = cleanName.substring(0, maxNameLen);
    return await member.setNickname(`[${title}] ${truncated}`);
  }

  return await member.setNickname(newNick);
}

/**
 * 멤버 닉네임에서 칭호 제거
 */
async function removeNickTitle(member, originalNick) {
  const currentNick = member.nickname || member.user.displayName;
  // [칭호] 부분 제거
  const cleanName = currentNick.replace(/^\[.+?\]\s*/, '').trim();
  await member.setNickname(cleanName || null);
}

module.exports = {
  setTitle,
  removeTitle,
  getTitle,
  getAllTitles,
  applyTitle,
  removeNickTitle,
};
