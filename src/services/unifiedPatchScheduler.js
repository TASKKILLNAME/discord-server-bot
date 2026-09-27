const { patchPayloads } = require('./patchLayout');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { pool } = require('../db');
const { deliverPatch, canonicalUrl } = require('./patchDelivery');

const lolCrawler = require('./patchCrawler');
const valorantCrawler = require('./valorantCrawler');
const tftCrawler = require('./tftCrawler');

const {
  SUMMARY_FAILED_MARKER,
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

      for (const payload of patchPayloads(embedData, patchData)) {
        await channel.send(payload);
      }
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
async function sendPatchEmbeds(channel, embedData, patchData, config, summaryFailed) {
  const alertEmbed = new EmbedBuilder()
    .setTitle(config.alertTitle)
    .setDescription(
      summaryFailed
        ? '⚠️ AI 요약에 실패했습니다. 아래 원문 링크를 확인해주세요.'
        : 'AI가 패치노트를 분석하고 요약했습니다.'
    )
    .setColor(config.alertColor)
    .setTimestamp();

  await channel.send({ embeds: [alertEmbed] });

  for (const payload of patchPayloads(embedData, patchData)) {
    await channel.send(payload);
  }
}

async function checkAndNotifyGame(client, gameKey) {
  const config = GAME_CONFIGS[gameKey];
  const gameApi = GAME_APIS[gameKey];

  try {
    const channels = await gameApi.getAllPatchChannels();
    if (!channels.length) return;
    const latest = await config.crawler.getLatestPatchUrl();
    if (!latest.url) throw new Error('최신 패치 URL 조회 실패');
    let prepared;
    const buildPayloads = () => prepared ||= (async () => {
    const patchData = await config.crawler.crawlPatchContent(latest.url);
    if (!patchData) throw new Error('패치 본문 조회 실패');

    console.log(`📰 ${config.name} 새 패치노트 감지: ${patchData.title}`);
    console.log(`🤖 ${config.name} AI 요약 생성 중...`);

    const summary = await config.summarize(patchData);
    const summaryFailed = summary.startsWith(SUMMARY_FAILED_MARKER);
    const embedData = config.format(summary, patchData);

    if (summaryFailed) {
      console.error(
        `⚠️ ${config.name} AI 요약 실패 상태로 알림을 전송합니다 (원문 링크만 유효): ${patchData.url}`
      );
    }

    // LoL 전용: 구조화된 patch.json 저장 (요약이 이미 실패했으면 같은 이유로 실패하므로 생략)
    if (gameKey === 'lol' && !summaryFailed) {
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

    const payloads = [];
    await sendPatchEmbeds({ send: async payload => {
      payloads.push(typeof payload === 'string' ? { content: payload } : JSON.parse(JSON.stringify(payload)));
    } }, embedData, patchData, config, summaryFailed);
    return payloads;
    })();
    let successCount = 0;
    let failCount = 0;

    for (const { guildId, channelId } of channels) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
          failCount++;
          continue;
        }
        if (await deliverPatch(gameKey, channel, latest.url, buildPayloads)) successCount++;
        else failCount++;
      } catch (err) {
        console.error(`❌ ${config.name} 패치 알림 실패 (서버: ${guildId}):`, err.message);
        failCount++;
      }
    }

    if (successCount === channels.length) {
      await pool.query(
        `INSERT INTO patch_state (game,last_url,last_title,checked_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (game) DO UPDATE SET last_url=$2,last_title=$3,checked_at=NOW()`,
        [gameKey, canonicalUrl(latest.url), latest.title || config.defaultTitle]
      );
    }
    console.log(`✅ ${config.name} 패치 배달 확인 완료 (완료: ${successCount}, 재시도 대기: ${failCount})`);
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

  // 단일 cron으로 3개 게임 동시 체크
  scheduledTask = cron.schedule('*/30 * * * *', async () => {
    console.log(`\n⏰ [${new Date().toLocaleString('ko-KR')}] 패치노트 체크 중 (롤/발로란트/TFT)...`);
    await Promise.all([
      checkAndNotifyGame(client, 'lol'),
      checkAndNotifyGame(client, 'valorant'),
      checkAndNotifyGame(client, 'tft'),
    ]);
  });
  console.log('🔍 시작 시 미전송 패치 확인 (채널별 전송 기록 기준)...');
  await Promise.all([
    checkAndNotifyGame(client, 'lol'),
    checkAndNotifyGame(client, 'valorant'),
    checkAndNotifyGame(client, 'tft'),
  ]);
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
