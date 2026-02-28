const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');

const LCK_CHANNELS_FILE = path.join(__dirname, '../../data/lckChannels.json');
const LAST_MATCH_FILE = path.join(__dirname, '../../data/lastLckMatch.json');

const CHZZK_API = 'https://api.chzzk.naver.com';

let scheduledTask = null;

// ============================================
// 📁 서버별 LCK 알림 채널 데이터 관리
// ============================================
function loadLckChannels() {
  try {
    if (fs.existsSync(LCK_CHANNELS_FILE)) {
      return JSON.parse(fs.readFileSync(LCK_CHANNELS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('LCK 채널 데이터 로드 오류:', err);
  }
  return {};
}

function saveLckChannels(data) {
  try {
    const dir = path.dirname(LCK_CHANNELS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LCK_CHANNELS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('LCK 채널 데이터 저장 오류:', err);
  }
}

function setLckChannel(guildId, discordChannelId, chzzkChannelId, chzzkChannelName) {
  const data = loadLckChannels();
  data[guildId] = {
    discordChannelId,
    chzzkChannelId,
    chzzkChannelName: chzzkChannelName || 'LCK',
    setAt: new Date().toISOString(),
  };
  saveLckChannels(data);
}

function removeLckChannel(guildId) {
  const data = loadLckChannels();
  delete data[guildId];
  saveLckChannels(data);
}

function getLckChannel(guildId) {
  return loadLckChannels()[guildId] || null;
}

function getAllLckChannels() {
  return Object.entries(loadLckChannels()).map(([guildId, info]) => ({
    guildId,
    ...info,
  }));
}

// ============================================
// 📁 마지막 알림 LCK 매치 상태 관리
// ============================================
function loadLastMatch() {
  try {
    if (fs.existsSync(LAST_MATCH_FILE)) {
      return JSON.parse(fs.readFileSync(LAST_MATCH_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('LCK 매치 데이터 로드 오류:', err);
  }
  return {};
}

function saveLastMatch(chzzkChannelId, data) {
  try {
    const dir = path.dirname(LAST_MATCH_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const all = loadLastMatch();
    all[chzzkChannelId] = data;
    fs.writeFileSync(LAST_MATCH_FILE, JSON.stringify(all, null, 2));
  } catch (err) {
    console.error('LCK 매치 데이터 저장 오류:', err);
  }
}

function getLastMatch(chzzkChannelId) {
  return loadLastMatch()[chzzkChannelId] || { liveId: null, title: null };
}

// ============================================
// 🔍 Chzzk API 연동
// ============================================

/**
 * Chzzk 채널 검색
 */
async function searchChzzkChannel(keyword) {
  try {
    const response = await axios.get(`${CHZZK_API}/service/v1/search/channels`, {
      params: { keyword, offset: 0, size: 10 },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      timeout: 10000,
    });

    const content = response.data?.content;
    if (!content?.data || !Array.isArray(content.data)) return [];

    return content.data.map((item) => ({
      channelId: item.channel?.channelId || '',
      channelName: item.channel?.channelName || '',
      followerCount: item.channel?.followerCount || 0,
      isLive: item.channel?.openLive || false,
    }));
  } catch (err) {
    console.error('Chzzk 채널 검색 실패:', err.message);
    return [];
  }
}

/**
 * Chzzk 채널 라이브 정보 가져오기
 */
async function getLiveDetail(chzzkChannelId) {
  try {
    const response = await axios.get(
      `${CHZZK_API}/service/v2/channels/${chzzkChannelId}/live-detail`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        timeout: 10000,
      }
    );

    const content = response.data?.content;
    if (!content) return null;

    return {
      liveId: content.liveId,
      liveTitle: content.liveTitle || '',
      status: content.status, // 'OPEN' | 'CLOSE'
      categoryType: content.categoryType || '',
      liveCategory: content.liveCategory || '',
      concurrentUserCount: content.concurrentUserCount || 0,
      liveImageUrl: content.liveImageUrl || null,
      channelId: content.channel?.channelId || chzzkChannelId,
      channelName: content.channel?.channelName || '',
    };
  } catch (err) {
    // 404 = 채널 없음 or 방송 없음
    if (err.response?.status === 404) return null;
    console.error(`Chzzk 라이브 정보 가져오기 실패 (${chzzkChannelId}):`, err.message);
    return null;
  }
}

// ============================================
// 📡 팀 이름 파싱
// ============================================

/**
 * 방송 제목에서 대전 팀 추출
 * 예: "2026 LCK 스프링 || T1 vs Gen.G"  →  ["T1", "Gen.G"]
 * 예: "[LIVE] T1 vs 한화생명 | LCK Spring"  →  ["T1", "한화생명"]
 */
function parseTeams(title) {
  if (!title) return null;

  // "팀A vs 팀B" 또는 "팀A VS 팀B" 패턴
  const vsMatch = title.match(/([^\s|[\]()]+(?:\s[^\s|[\]()vs]+)*)\s+[Vv][Ss]\.?\s+([^\s|[\]()]+(?:\s[^\s|[\]()]+)*)/);
  if (vsMatch) {
    const team1 = vsMatch[1].trim().replace(/[[\]|]/g, '').trim();
    const team2 = vsMatch[2].trim().replace(/[[\]|]/g, '').trim();
    if (team1 && team2) return [team1, team2];
  }

  return null;
}

// ============================================
// 📣 LCK 알림 전송
// ============================================

async function sendLckNotification(channel, liveData, teams, chzzkChannelId) {
  const embed = new EmbedBuilder()
    .setTitle('🏆 LCK 경기가 시작되었습니다!')
    .setColor(0x003087) // LCK 블루
    .setTimestamp()
    .setFooter({ text: '🎮 치지직(Chzzk) LCK 알림' });

  if (teams && teams.length === 2) {
    embed.setDescription(`## ⚔️  ${teams[0]}  **vs**  ${teams[1]}`);
    embed.addFields({
      name: '📺 방송 제목',
      value: liveData.liveTitle || '제목 없음',
    });
  } else {
    embed.setDescription(`**${liveData.liveTitle || 'LCK 경기'}**`);
  }

  embed.addFields(
    {
      name: '👥 시청자',
      value: liveData.concurrentUserCount.toLocaleString('ko-KR') + '명',
      inline: true,
    },
    {
      name: '📡 채널',
      value: liveData.channelName || 'LCK',
      inline: true,
    }
  );

  if (liveData.liveImageUrl) {
    embed.setImage(liveData.liveImageUrl);
  }

  const liveUrl = `https://chzzk.naver.com/live/${chzzkChannelId}`;
  await channel.send({
    content: `🔴 **LCK 경기 시작!** 지금 바로 시청하세요 → ${liveUrl}`,
    embeds: [embed],
  });
}

// ============================================
// 🔄 LCK 라이브 체크 스케줄러
// ============================================

/**
 * 모든 등록된 서버의 Chzzk 채널 라이브 상태 체크
 */
async function checkLckLive(client) {
  const servers = getAllLckChannels();
  if (servers.length === 0) return;

  // 중복 채널 ID 방지: 같은 chzzkChannelId는 한 번만 API 호출
  const checkedChannels = new Map();

  for (const server of servers) {
    const { guildId, discordChannelId, chzzkChannelId, chzzkChannelName } = server;

    if (!chzzkChannelId) continue;

    let liveData;
    if (checkedChannels.has(chzzkChannelId)) {
      liveData = checkedChannels.get(chzzkChannelId);
    } else {
      liveData = await getLiveDetail(chzzkChannelId);
      checkedChannels.set(chzzkChannelId, liveData);
    }

    if (!liveData || liveData.status !== 'OPEN') continue;

    const lastMatch = getLastMatch(chzzkChannelId);

    // 이미 알림을 보낸 라이브 세션이면 스킵
    if (lastMatch.liveId === liveData.liveId) continue;

    console.log(`🏆 LCK 라이브 감지! (채널: ${chzzkChannelName}, 제목: ${liveData.liveTitle})`);

    // 라이브 ID 저장 (중복 알림 방지)
    saveLastMatch(chzzkChannelId, {
      liveId: liveData.liveId,
      title: liveData.liveTitle,
      notifiedAt: new Date().toISOString(),
    });

    // 팀 파싱
    const teams = parseTeams(liveData.liveTitle);

    // Discord 알림 전송
    try {
      const discordChannel = await client.channels.fetch(discordChannelId);
      if (discordChannel) {
        await sendLckNotification(discordChannel, liveData, teams, chzzkChannelId);
        console.log(`✅ LCK 알림 전송 완료 (서버: ${guildId})`);
      }
    } catch (err) {
      console.error(`❌ LCK 알림 전송 실패 (서버: ${guildId}):`, err.message);
    }
  }
}

/**
 * 봇 시작 시 현재 라이브 상태 동기화 (알림 없음, 중복 알림 방지)
 */
async function syncCurrentLive() {
  try {
    const servers = getAllLckChannels();
    const checkedChannels = new Set();

    for (const { chzzkChannelId, chzzkChannelName } of servers) {
      if (!chzzkChannelId || checkedChannels.has(chzzkChannelId)) continue;
      checkedChannels.add(chzzkChannelId);

      const liveData = await getLiveDetail(chzzkChannelId);
      if (liveData && liveData.status === 'OPEN' && liveData.liveId) {
        const lastMatch = getLastMatch(chzzkChannelId);
        if (lastMatch.liveId !== liveData.liveId) {
          saveLastMatch(chzzkChannelId, {
            liveId: liveData.liveId,
            title: liveData.liveTitle,
            notifiedAt: null, // null = 알림 안 보냄 (동기화만)
          });
          console.log(`📋 LCK 현재 라이브 기록 완료 (알림 없음): ${chzzkChannelName} - ${liveData.liveTitle}`);
        }
      }
    }
  } catch (err) {
    console.error('LCK 라이브 동기화 실패:', err.message);
  }
}

/**
 * LCK 알림 스케줄러 시작 (5분마다 체크)
 */
async function startLckScheduler(client) {
  const servers = getAllLckChannels();

  if (servers.length === 0) {
    console.log('⚠️ LCK 알림이 설정된 서버가 없습니다.');
  } else {
    console.log(`🏆 LCK 알림 스케줄러 시작 (5분 간격, ${servers.length}개 서버)`);
  }

  // ✅ 시작 전 현재 라이브 동기화 (봇 재시작 시 중복 알림 방지)
  console.log('🔍 LCK 초기 라이브 상태 동기화 (알림 없음)...');
  await syncCurrentLive();

  // 5분마다 라이브 체크
  scheduledTask = cron.schedule('*/5 * * * *', async () => {
    await checkLckLive(client);
  });
}

function stopLckScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    console.log('⏹️ LCK 알림 스케줄러 중지됨');
  }
}

module.exports = {
  startLckScheduler,
  stopLckScheduler,
  checkLckLive,
  searchChzzkChannel,
  getLiveDetail,
  parseTeams,
  setLckChannel,
  removeLckChannel,
  getLckChannel,
  getAllLckChannels,
  loadLckChannels,
};
