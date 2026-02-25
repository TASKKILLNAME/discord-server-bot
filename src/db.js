const { Pool } = require('pg');

const isInternalRailway = process.env.DATABASE_URL?.includes('railway.internal');
const isPublicRailway   = process.env.DATABASE_URL?.includes('railway.app');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isInternalRailway ? false
     : isPublicRailway   ? { rejectUnauthorized: false }
     : false,
});

// 풀 에러 핸들링 (연결 끊김 등)
pool.on('error', (err) => {
  console.error('❌ DB 풀 에러:', err.message);
});

/**
 * 레벨 테이블 초기화 (없으면 생성)
 */
async function initDb() {
  try {
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
  } catch (err) {
    console.error('❌ DB 초기화 실패:', err.message);
    console.error('   DATABASE_URL 설정 확인:', process.env.DATABASE_URL ? '있음' : '없음');
  }
}

module.exports = { pool, initDb };
