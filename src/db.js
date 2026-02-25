const { Pool } = require('pg');

const isInternalRailway = process.env.DATABASE_URL?.includes('railway.internal');
const isPublicRailway   = process.env.DATABASE_URL?.includes('railway.app');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isInternalRailway ? false
     : isPublicRailway   ? { rejectUnauthorized: false }
     : false,
});

/**
 * 레벨 테이블 초기화 (없으면 생성)
 */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS levels (
      guild_id     VARCHAR(20) NOT NULL,
      user_id      VARCHAR(20) NOT NULL,
      xp           INTEGER     DEFAULT 0,
      level        INTEGER     DEFAULT 0,
      message_count INTEGER    DEFAULT 0,
      last_xp_time  BIGINT     DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  console.log('✅ DB 초기화 완료 (levels 테이블)');
}

module.exports = { pool, initDb };
