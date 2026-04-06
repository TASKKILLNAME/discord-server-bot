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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS welcome_settings (
        guild_id   VARCHAR(20) PRIMARY KEY,
        enabled    BOOLEAN     DEFAULT false,
        channel_id VARCHAR(20),
        message    TEXT
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lol_tracker_settings (
        guild_id   VARCHAR(20) PRIMARY KEY,
        channel_id VARCHAR(20)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lol_tracker_players (
        guild_id      VARCHAR(20)  NOT NULL,
        user_id       VARCHAR(20)  NOT NULL,
        game_name     VARCHAR(100) NOT NULL,
        tag_line      VARCHAR(20)  NOT NULL,
        puuid         VARCHAR(100) NOT NULL,
        in_game       BOOLEAN      DEFAULT false,
        last_game_id  VARCHAR(50),
        last_rank     JSONB,
        registered_at TIMESTAMPTZ  DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patch_state (
        game       VARCHAR(20) PRIMARY KEY,
        last_url   TEXT,
        last_title TEXT,
        checked_at TIMESTAMPTZ
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memberships (
        guild_id        VARCHAR(20) NOT NULL,
        user_id         VARCHAR(20) NOT NULL,
        credits         INTEGER     DEFAULT 0,
        total_purchased INTEGER     DEFAULT 0,
        tier            VARCHAR(20),
        PRIMARY KEY (guild_id, user_id)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS membership_history (
        id        SERIAL PRIMARY KEY,
        guild_id  VARCHAR(20) NOT NULL,
        user_id   VARCHAR(20) NOT NULL,
        type      VARCHAR(10) NOT NULL,
        amount    INTEGER     NOT NULL,
        action    TEXT,
        tier      VARCHAR(20),
        admin_id  VARCHAR(20),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patch_channels (
        guild_id   VARCHAR(20) NOT NULL,
        game       VARCHAR(20) NOT NULL,
        channel_id VARCHAR(20) NOT NULL,
        set_at     TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (guild_id, game)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS titles (
        guild_id      VARCHAR(20) NOT NULL,
        user_id       VARCHAR(20) NOT NULL,
        title         VARCHAR(20) NOT NULL,
        original_nick VARCHAR(32),
        set_by        VARCHAR(20),
        set_at        TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS limbus_profiles (
        guild_id        VARCHAR(20) NOT NULL,
        user_id         VARCHAR(20) NOT NULL,
        story_chapter   INTEGER     DEFAULT 0,
        mirror_floor    INTEGER     DEFAULT 0,
        identity_count  INTEGER     DEFAULT 0,
        ego_count       INTEGER     DEFAULT 0,
        level           INTEGER     DEFAULT 1,
        main_sinner     VARCHAR(50),
        main_identity   VARCHAR(100),
        note            TEXT,
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
      );
    `);
    console.log('✅ DB 초기화 완료 (levels, welcome_settings, lol_tracker, patch_state, memberships, patch_channels, titles, limbus_profiles 테이블)');
  } catch (err) {
    console.error('❌ DB 초기화 실패:', err.message);
    console.error('   DATABASE_URL 설정 확인:', process.env.DATABASE_URL ? '있음' : '없음');
  }
}

module.exports = { pool, initDb };
