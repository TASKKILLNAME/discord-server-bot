const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { pool } = require('../db');

const lolCrawler = require('./patchCrawler');
const valorantCrawler = require('./valorantCrawler');
const tftCrawler = require('./tftCrawler');

const {
  summarizePatchNotes,
  formatForDiscord,
  extractStructuredPatchData,
  summarizeTftPatchNotes,
  formatTftForDiscord,
  summarizeValorantPatchNotes,
  formatValorantForDiscord,
} = require('./aiSummarizer');

const DATA_DIR = path.join(__dirname, '../../data');
const PATCH_DATA_FILE = path.join(DATA_DIR, 'patch.json');

// ============================================
// 게임별 설정
// ============================================
const GAME_CONFIGS = {
  lol: {
    name: '롤',
    gameKey: 'lol',
    crawler: lolCrawler,
    summarize: summarizePatchNotes,
    format: formatForDiscord,
    alertTitle: '🔔 새로운 롤 패치노트가 발표되었습니다!',
    alertColor: 0xff4444,
    defaultTitle: '롤 패치노트',
  },
  valorant: {
    name: '발로란트',
    gameKey: 'valorant',
    crawler: valorantCrawler,
    summarize: summarizeValorantPatchNotes,
    format: formatValorantForDiscord,
    alertTitle: '🔔 새로운 발로란트 패치노트가 발표되었습니다!',
    alertColor: 0xff4655,
    defaultTitle: '발로란트 패치노트',
  },
  tft: {
    name: 'TFT',
    gameKey: 'tft',
    crawler: tftCrawler,
    summarize: summarizeTftPatchNotes,
    format: formatTftForDiscord,
    alertTitle: '🔔 새로운 TFT 패치노트가 발표되었습니다!',
    alertColor: 0xc89b3c,
    defaultTitle: 'TFT 패치노트',
  },
};

// ============================================
// 채널 데이터 관리 (PostgreSQL)
// ============================================
async function loadChannels(gameKey) {
  try {
    const { rows } = await pool.query(
      'SELECT guild_id, channel_id FROM patch_channels WHERE game = $1',
      [gameKey]
    );
    const data = {};
    for (const row of rows) {
      data[row.guild_id] = { channelId: row.channel_id };
    }
    return data;
  } catch (err) {
    console.error('패치 채널 데이터 로드 오류:', err.message);
    return {};
  }
}

async function saveChannel(gameKey, guildId, channelId) {
  await pool.query(
    `INSERT INTO patch_channels (guild_id, game, channel_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, game) DO UPDATE SET channel_id = $3, set_at = NOW()`,
    [guildId, gameKey, channelId]
  );
}

async function removeChannel(gameKey, guildId) {
  await pool.query(
    'DELETE FROM patch_channels WHERE guild_id = $1 AND game = $2',
    [guildId, gameKey]
  );
}

async function getChannel(gameKey, guildId) {
  const { rows } = await pool.query(
    'SELECT channel_id FROM patch_channels WHERE guild_id = $1 AND game = $2',
    [guildId, gameKey]
  );
  return rows[0]?.channel_id || null;
}

async function getAllChannels(gameKey) {
  const { rows } = await pool.query(
    'SELECT guild_id, channel_id FROM patch_channels WHERE game = $1',
    [gameKey]
  );
  return rows.map((r) => ({ guildId: r.guild_id, channelId: r.channel_id }));
}

// ============================================
// 게임별 API 객체 생성
// ============================================
function makeGameApi(gameKey) {
  const config = GAME_CONFIGS[gameKey];

  return {
    async setPatchChannel(guildId, channelId) {
      await saveChannel(gameKey, guildId, channelId);
    },
    async removePatchChannel(guildId) {
      await removeChannel(gameKey, guildId);
    },
    async getPatchChannel(guildId) {
      return getChannel(gameKey, guildId);
    },
    async getAllPatchChannels() {
      return getAllChannels(gameKey);
    },

    // 크롤러 위임 (커맨드에서 사용)
    forceGetLatestPatch: config.crawler.forceGetLatestPatch,
    loadLastPatch: config.crawler.loadLastPatch,

    // 채널에 패치노트 전송 (명령어용)
    async sendPatchToChannel(channel, patchData) {
      console.log(`🤖 ${config.name} AI 요약 생성 중...`);
      const summary = await config.summarize(patchData);
      const embedData = config.format(summary, patchData);

      const patchEmbed = new EmbedBuilder()
        .setTitle(embedData.title)
        .setURL(embedData.url)
        .setColor(embedData.color)
        .setTimestamp()
        .setFooter(embedData.footer);

      if (embedData.thumbnail) patchEmbed.setThumbnail(embedData.thumbnail.url);
      for (const field of embedData.fields.slice(0, 25)) patchEmbed.addFields(field);

      await channel.send({ embeds: [patchEmbed] });
      await channel.send(`📎 **원문 보기:** ${patchData.url}`);
    },
  };
}

// 게임별 API 객체
const lol = makeGameApi('lol');
const valorant = makeGameApi('valorant');
const tft = makeGameApi('tft');

const GAME_APIS = { lol, valorant, tft };

// ============================================
// 스케줄러 내부 함수
// ============================================
async function syncCurrentPatch(gameKey) {
  const config = GAME_CONFIGS[gameKey];
  try {
    const latest = await config.crawler.getLatestPatchUrl();
    if (!latest.url) {
      console.log(`⚠️ ${config.name} 패치노트 URL을 가져올 수 없어 동기화 스킵`);
      return;
    }
    const lastPatch = await config.crawler.loadLastPatch();
    if (lastPatch.lastUrl === latest.url) {
      console.log(`📋 ${config.name} 패치 기록 최신 상태: ${lastPatch.lastTitle || latest.url}`);
      return;
    }
    await config.crawler.saveLastPatch({
      lastUrl: latest.url,
      lastTitle: latest.title || config.defaultTitle,
    });
    console.log(`📋 ${config.name} 현재 패치 기록 완료: ${latest.title || latest.url} (알림 없음)`);
  } catch (err) {
    console.error(`${config.name} 패치 동기화 실패:`, err.message);
  }
}

async function sendPatchEmbeds(channel, embedData, patchData, config) {
  const alertEmbed = new EmbedBuilder()
    .setTitle(config.alertTitle)
    .setDescription('AI가 패치노트를 분석하고 요약했습니다.')
    .setColor(config.alertColor)
    .setTimestamp();

  await channel.send({ embeds: [alertEmbed] });

  const patchEmbed = new EmbedBuilder()
    .setTitle(embedData.title)
    .setURL(embedData.url)
    .setColor(embedData.color)
    .setTimestamp()
    .setFooter(embedData.footer);

  if (embedData.thumbnail) patchEmbed.setThumbnail(embedData.thumbnail.url);

  const maxFieldsPerEmbed = 25;
  const fieldChunks = [];
  for (let i = 0; i < embedData.fields.length; i += maxFieldsPerEmbed) {
    fieldChunks.push(embedData.fields.slice(i, i + maxFieldsPerEmbed));
  }

  if (fieldChunks.length > 0) {
    for (const field of fieldChunks[0]) patchEmbed.addFields(field);
    await channel.send({ embeds: [patchEmbed] });
  }

  for (let i = 1; i < fieldChunks.length; i++) {
    const extraEmbed = new EmbedBuilder().setColor(embedData.color);
    for (const field of fieldChunks[i]) extraEmbed.addFields(field);
    await channel.send({ embeds: [extraEmbed] });
  }

  await channel.send(`📎 **원문 보기:** ${patchData.url}`);
}

async function checkAndNotifyGame(client, gameKey) {
  const config = GAME_CONFIGS[gameKey];
  const gameApi = GAME_APIS[gameKey];

  try {
    const patchData = await config.crawler.checkForNewPatch();
    if (!patchData) return;

    console.log(`📰 ${config.name} 새 패치노트 감지: ${patchData.title}`);
    console.log(`🤖 ${config.name} AI 요약 생성 중...`);

    const summary = await config.summarize(patchData);
    const embedData = config.format(summary, patchData);

    // LoL 전용: 구조화된 patch.json 저장
    if (gameKey === 'lol') {
      try {
        const structuredData = await extractStructuredPatchData(patchData);
        if (structuredData) {
          if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(PATCH_DATA_FILE, JSON.stringify({
            version: patchData.title || '',
            updatedAt: new Date().toISOString(),
            url: patchData.url || '',
            ...structuredData,
          }, null, 2));
          console.log('📦 patch.json 생성 완료');
        }
      } catch (patchErr) {
        console.error('patch.json 생성 실패 (알림은 계속 전송):', patchErr.message);
      }
    }

    const channels = await gameApi.getAllPatchChannels();
    let successCount = 0;
    let failCount = 0;

    for (const { guildId, channelId } of channels) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
          failCount++;
          continue;
        }
        await sendPatchEmbeds(channel, embedData, patchData, config);
        successCount++;
      } catch (err) {
        console.error(`❌ ${config.name} 패치 알림 실패 (서버: ${guildId}):`, err.message);
        failCount++;
      }
    }

    console.log(`✅ ${config.name} 패치노트 알림 전송 완료! (성공: ${successCount}, 실패: ${failCount})`);
  } catch (err) {
    console.error(`❌ ${config.name} 패치노트 체크 실패:`, err.message);
  }
}

// ============================================
// 스케줄러 시작/중지
// ============================================
let scheduledTask = null;

async function startUnifiedPatchScheduler(client) {
  // 등록된 서버 수 로그
  const lolChannels = await lol.getAllPatchChannels();
  const valorantChannels = await valorant.getAllPatchChannels();
  const tftChannels = await tft.getAllPatchChannels();

  const lolCount = lolChannels.length;
  const valorantCount = valorantChannels.length;
  const tftCount = tftChannels.length;

  if (lolCount + valorantCount + tftCount === 0) {
    console.log('⚠️ 패치노트 알림 채널이 설정된 서버가 없습니다.');
  } else {
    console.log(`🔄 통합 패치노트 스케줄러 시작 (30분 간격)`);
    console.log(`   롤: ${lolCount}개 | 발로란트: ${valorantCount}개 | TFT: ${tftCount}개 서버`);
  }

  // 시작 전 전체 동기화 (알림 없음, 재시작 시 중복 알림 방지)
  console.log('🔍 초기 패치노트 동기화 (알림 없음)...');
  await Promise.all([
    syncCurrentPatch('lol'),
    syncCurrentPatch('valorant'),
    syncCurrentPatch('tft'),
  ]);

  // 단일 cron으로 3개 게임 동시 체크
  scheduledTask = cron.schedule('*/30 * * * *', async () => {
    console.log(`\n⏰ [${new Date().toLocaleString('ko-KR')}] 패치노트 체크 중 (롤/발로란트/TFT)...`);
    await Promise.all([
      checkAndNotifyGame(client, 'lol'),
      checkAndNotifyGame(client, 'valorant'),
      checkAndNotifyGame(client, 'tft'),
    ]);
  });
}

function stopUnifiedPatchScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    console.log('⏹️ 통합 패치노트 스케줄러 중지됨');
  }
}

module.exports = {
  startUnifiedPatchScheduler,
  stopUnifiedPatchScheduler,
  lol,
  valorant,
  tft,
};
