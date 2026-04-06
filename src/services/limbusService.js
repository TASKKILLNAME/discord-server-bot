const { pool } = require('../db');

async function getProfile(guildId, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM limbus_profiles WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId]
  );
  return rows[0] || null;
}

async function upsertProfile(guildId, userId, data) {
  const { rows } = await pool.query(
    `INSERT INTO limbus_profiles (guild_id, user_id, story_chapter, mirror_floor, identity_count, ego_count, level, main_sinner, main_identity, note, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (guild_id, user_id) DO UPDATE SET
       story_chapter  = COALESCE($3, limbus_profiles.story_chapter),
       mirror_floor   = COALESCE($4, limbus_profiles.mirror_floor),
       identity_count = COALESCE($5, limbus_profiles.identity_count),
       ego_count      = COALESCE($6, limbus_profiles.ego_count),
       level          = COALESCE($7, limbus_profiles.level),
       main_sinner    = COALESCE($8, limbus_profiles.main_sinner),
       main_identity  = COALESCE($9, limbus_profiles.main_identity),
       note           = COALESCE($10, limbus_profiles.note),
       updated_at     = NOW()
     RETURNING *`,
    [
      guildId, userId,
      data.storyChapter, data.mirrorFloor,
      data.identityCount, data.egoCount,
      data.level, data.mainSinner, data.mainIdentity, data.note,
    ]
  );
  return rows[0];
}

async function deleteProfile(guildId, userId) {
  const { rowCount } = await pool.query(
    'DELETE FROM limbus_profiles WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId]
  );
  return rowCount > 0;
}

async function getRanking(guildId) {
  const { rows } = await pool.query(
    `SELECT * FROM limbus_profiles
     WHERE guild_id = $1
     ORDER BY story_chapter DESC, mirror_floor DESC, level DESC`,
    [guildId]
  );
  return rows;
}

module.exports = {
  getProfile,
  upsertProfile,
  deleteProfile,
  getRanking,
};
