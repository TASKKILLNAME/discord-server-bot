const { pool } = require('../db');

// ============================================
// 💰 멤버십 티어 정의
// ============================================
const TIERS = {
  bronze: { name: '🥉 브론즈', price: '1,000원', credits: 8, emoji: '🥉' },
  silver: { name: '🥈 실버', price: '5,000원', credits: 40, emoji: '🥈' },
  gold: { name: '🥇 골드', price: '10,000원', credits: 83, emoji: '🥇' },
};

// ============================================
// 💳 크레딧 조회
// ============================================
async function getCredits(guildId, userId) {
  const { rows } = await pool.query(
    'SELECT credits FROM memberships WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId]
  );
  return rows[0]?.credits || 0;
}

async function getMembershipInfo(guildId, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM memberships WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId]
  );
  if (!rows[0]) return null;
  const row = rows[0];

  const { rows: history } = await pool.query(
    `SELECT type, amount, action, tier, admin_id AS "by", created_at AS "at"
     FROM membership_history
     WHERE guild_id = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT 50`,
    [guildId, userId]
  );

  return {
    credits: row.credits,
    totalPurchased: row.total_purchased,
    tier: row.tier,
    history,
  };
}

// ============================================
// ✅ 크레딧 보유 확인 (차감 없이 체크만)
// ============================================
async function hasCredit(guildId, userId) {
  const credits = await getCredits(guildId, userId);
  return credits > 0;
}

// ============================================
// 🔻 크레딧 사용 (1회 차감)
// ============================================
async function useCredit(guildId, userId, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT credits FROM memberships WHERE guild_id = $1 AND user_id = $2 FOR UPDATE',
      [guildId, userId]
    );

    if (!rows[0] || rows[0].credits <= 0) {
      await client.query('ROLLBACK');
      return false;
    }

    await client.query(
      'UPDATE memberships SET credits = credits - 1 WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId]
    );

    await client.query(
      `INSERT INTO membership_history (guild_id, user_id, type, amount, action)
       VALUES ($1, $2, 'use', -1, $3)`,
      [guildId, userId, action]
    );

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('크레딧 사용 오류:', err.message);
    return false;
  } finally {
    client.release();
  }
}

// ============================================
// ➕ 크레딧 충전
// ============================================
async function chargeCredits(guildId, userId, amount, tier, adminId) {
  await pool.query(
    `INSERT INTO memberships (guild_id, user_id, credits, total_purchased, tier)
     VALUES ($1, $2, $3, $3, $4)
     ON CONFLICT (guild_id, user_id) DO UPDATE
     SET credits = memberships.credits + $3,
         total_purchased = memberships.total_purchased + $3,
         tier = $4`,
    [guildId, userId, amount, tier]
  );

  await pool.query(
    `INSERT INTO membership_history (guild_id, user_id, type, amount, tier, admin_id)
     VALUES ($1, $2, 'charge', $3, $4, $5)`,
    [guildId, userId, amount, tier, adminId]
  );

  const { rows } = await pool.query(
    'SELECT * FROM memberships WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId]
  );
  return rows[0] ? {
    credits: rows[0].credits,
    totalPurchased: rows[0].total_purchased,
    tier: rows[0].tier,
  } : null;
}

// ============================================
// 🌐 웹 대시보드용 함수
// ============================================

async function getAllMembershipData() {
  const { rows } = await pool.query('SELECT * FROM memberships');
  const data = {};
  for (const row of rows) {
    if (!data[row.guild_id]) data[row.guild_id] = {};
    data[row.guild_id][row.user_id] = {
      credits: row.credits,
      totalPurchased: row.total_purchased,
      tier: row.tier,
    };
  }
  return data;
}

async function getGuildMembershipData(guildId) {
  const { rows } = await pool.query(
    'SELECT * FROM memberships WHERE guild_id = $1',
    [guildId]
  );
  const data = {};
  for (const row of rows) {
    data[row.user_id] = {
      credits: row.credits,
      totalPurchased: row.total_purchased,
      tier: row.tier,
    };
  }
  return data;
}

async function getMembershipStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) AS total_users,
      COALESCE(SUM(credits), 0) AS total_credits_remaining,
      COALESCE(SUM(total_purchased), 0) AS total_purchased
    FROM memberships
  `);

  const { rows: useRows } = await pool.query(`
    SELECT COUNT(*) AS total_used FROM membership_history WHERE type = 'use'
  `);

  const { rows: serverRows } = await pool.query(`
    SELECT
      guild_id,
      COUNT(*) AS users,
      COALESCE(SUM(credits), 0) AS credits_remaining,
      COALESCE(SUM(total_purchased), 0) AS total_purchased
    FROM memberships
    GROUP BY guild_id
  `);

  const serverStats = {};
  for (const row of serverRows) {
    const { rows: srvUse } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM membership_history WHERE guild_id = $1 AND type = 'use'`,
      [row.guild_id]
    );
    serverStats[row.guild_id] = {
      users: parseInt(row.users),
      creditsRemaining: parseInt(row.credits_remaining),
      totalPurchased: parseInt(row.total_purchased),
      totalUsed: parseInt(srvUse[0]?.cnt || 0),
    };
  }

  return {
    totalUsers: parseInt(rows[0].total_users),
    totalCreditsRemaining: parseInt(rows[0].total_credits_remaining),
    totalPurchased: parseInt(rows[0].total_purchased),
    totalUsed: parseInt(useRows[0].total_used),
    serverStats,
  };
}

module.exports = {
  TIERS,
  getCredits,
  getMembershipInfo,
  hasCredit,
  useCredit,
  chargeCredits,
  getAllMembershipData,
  getGuildMembershipData,
  getMembershipStats,
};
