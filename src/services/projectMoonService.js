const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { getLiveDetail } = require('./chzzkService');

/**
 * Project Moon 공식 채널 알림 서비스
 *
 * 1) YouTube: 공식 채널 RSS 폴링 → 새 영상 업로드 시 알림
 * 2) 치지직(Chzzk): 공식 채널 라이브 상태 폴링 → 방송 시작 시 알림
 *
 * 이 서버(MANHANDLING) 전용이라 채널 ID를 상수로 고정한다.
 * 채널을 다시 만들면 아래 DISCORD 채널 ID만 갱신하면 된다.
 */

// ── Project Moon 공식 소스 채널 ──
const PM_YOUTUBE_CHANNEL_ID = 'UCpqyr6h4RCXCEswHlkSjykA'; // ProjectMoon Official
const PM_CHZZK_CHANNEL_ID = '88ef610910ea642c198e0b05bca9967f'; // 프로젝트문 오피셜

// ── 알림을 보낼 Discord 채널 (🎮 림버스 카테고리) ──
const YOUTUBE_DISCORD_CHANNEL_ID = '1510975215314800710'; // 📝Project-Moon-유튜브
const LIVE_DISCORD_CHANNEL_ID = '1510975219097927821'; // 🎮Project-Moon-치지직

const YOUTUBE_RSS = `https://www.youtube.com/feeds/videos.xml?channel_id=${PM_YOUTUBE_CHANNEL_ID}`;
const STATE_FILE = path.join(__dirname, '../../data/projectMoonState.json');

let scheduledTask = null;

// ============================================
// 📁 상태 관리 (마지막으로 알림 보낸 영상/라이브)
// ============================================
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[ProjectMoon] 상태 로드 오류:', err.message);
  }
  return { lastVideoId: null, lastLiveId: null };
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[ProjectMoon] 상태 저장 오류:', err.message);
  }
}

// ============================================
// 📺 YouTube RSS
// ============================================
function decodeXml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * RSS XML에서 최신 영상 1개 파싱
 */
function parseLatestVideo(xml) {
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) return null;
  const entry = entryMatch[1];

  const videoId = (entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1];
  if (!videoId) return null;

  const title = decodeXml((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
  const published = (entry.match(/<published>(.*?)<\/published>/) || [])[1] || null;
  const thumbnail = (entry.match(/<media:thumbnail\s+url="(.*?)"/) || [])[1] || null;
  const author =
    decodeXml((xml.match(/<author>[\s\S]*?<name>(.*?)<\/name>/) || [])[1] || '') ||
    'ProjectMoon Official';

  return {
    videoId,
    title,
    published,
    thumbnail,
    author,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

async function fetchLatestVideo() {
  try {
    const { data } = await axios.get(YOUTUBE_RSS, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });
    return parseLatestVideo(data);
  } catch (err) {
    console.error('[ProjectMoon] YouTube RSS 조회 실패:', err.message);
    return null;
  }
}

async function sendYouTubeNotification(channel, video) {
  const embed = new EmbedBuilder()
    .setTitle(video.title || '새 영상')
    .setURL(video.url)
    .setColor(0xff0000) // YouTube 레드
    .setAuthor({ name: `${video.author} · 새 영상` })
    .setFooter({ text: '📺 Project Moon 유튜브 알림' })
    .setTimestamp(video.published ? new Date(video.published) : new Date());

  if (video.thumbnail) embed.setImage(video.thumbnail);

  await channel.send({
    content: `📺 **Project Moon 공식 유튜브에 새 영상이 올라왔어요!**\n${video.url}`,
    embeds: [embed],
  });
}

// ============================================
// 🔴 치지직 라이브
// ============================================
async function sendLiveNotification(channel, liveData) {
  const liveUrl = `https://chzzk.naver.com/live/${PM_CHZZK_CHANNEL_ID}`;

  const embed = new EmbedBuilder()
    .setTitle(liveData.liveTitle || 'Project Moon 방송')
    .setURL(liveUrl)
    .setColor(0x03c75a) // 치지직 그린
    .setAuthor({ name: `${liveData.channelName || 'ProjectMoon Official'} · 방송 시작` })
    .setFooter({ text: '🔴 Project Moon 치지직 알림' })
    .setTimestamp();

  const fields = [];
  if (liveData.liveCategory || liveData.categoryType) {
    fields.push({
      name: '🎮 카테고리',
      value: liveData.liveCategory || liveData.categoryType,
      inline: true,
    });
  }
  fields.push({
    name: '👥 시청자',
    value: `${(liveData.concurrentUserCount || 0).toLocaleString('ko-KR')}명`,
    inline: true,
  });
  embed.addFields(fields);

  if (liveData.liveImageUrl) {
    embed.setImage(liveData.liveImageUrl.replace('{type}', '720'));
  }

  await channel.send({
    content: `🔴 **Project Moon 공식 방송이 시작됐어요!** 지금 보러가기 → ${liveUrl}`,
    embeds: [embed],
  });
}

// ============================================
// 🔄 체크 로직
// ============================================
async function checkYouTube(client) {
  const video = await fetchLatestVideo();
  if (!video) return;

  const state = loadState();

  // 처음 실행(기록 없음)이면 알림 없이 현재 영상만 기록 (과거 영상 도배 방지)
  if (!state.lastVideoId) {
    state.lastVideoId = video.videoId;
    saveState(state);
    console.log(`[ProjectMoon] YouTube 초기 동기화: ${video.title} (알림 없음)`);
    return;
  }

  if (state.lastVideoId === video.videoId) return;

  console.log(`[ProjectMoon] 새 YouTube 영상 감지: ${video.title}`);
  state.lastVideoId = video.videoId;
  saveState(state);

  try {
    const channel = await client.channels.fetch(YOUTUBE_DISCORD_CHANNEL_ID);
    if (channel) {
      await sendYouTubeNotification(channel, video);
      console.log('[ProjectMoon] YouTube 알림 전송 완료');
    }
  } catch (err) {
    console.error('[ProjectMoon] YouTube 알림 전송 실패:', err.message);
  }
}

async function checkChzzkLive(client) {
  const liveData = await getLiveDetail(PM_CHZZK_CHANNEL_ID);
  if (!liveData || liveData.status !== 'OPEN' || !liveData.liveId) return;

  const state = loadState();

  // 이미 알림 보낸 라이브면 스킵
  if (state.lastLiveId === liveData.liveId) return;

  console.log(`[ProjectMoon] 치지직 라이브 감지: ${liveData.liveTitle}`);
  state.lastLiveId = liveData.liveId;
  saveState(state);

  try {
    const channel = await client.channels.fetch(LIVE_DISCORD_CHANNEL_ID);
    if (channel) {
      await sendLiveNotification(channel, liveData);
      console.log('[ProjectMoon] 치지직 알림 전송 완료');
    }
  } catch (err) {
    console.error('[ProjectMoon] 치지직 알림 전송 실패:', err.message);
  }
}

/**
 * 봇 시작 시 현재 상태 동기화 (알림 없이 기록만)
 * → 재시작 시 과거 영상/진행 중 방송 중복 알림 방지
 */
async function syncCurrent() {
  const state = loadState();
  let changed = false;

  // YouTube: 최신 영상 기록만
  if (!state.lastVideoId) {
    const video = await fetchLatestVideo();
    if (video) {
      state.lastVideoId = video.videoId;
      changed = true;
      console.log(`[ProjectMoon] YouTube 초기 동기화: ${video.title}`);
    }
  }

  // 치지직: 현재 방송 중이면 그 라이브 기록만 (알림 없음)
  try {
    const liveData = await getLiveDetail(PM_CHZZK_CHANNEL_ID);
    if (liveData && liveData.status === 'OPEN' && liveData.liveId) {
      if (state.lastLiveId !== liveData.liveId) {
        state.lastLiveId = liveData.liveId;
        changed = true;
        console.log(`[ProjectMoon] 치지직 초기 동기화: ${liveData.liveTitle} (알림 없음)`);
      }
    }
  } catch (err) {
    console.error('[ProjectMoon] 치지직 초기 동기화 실패:', err.message);
  }

  if (changed) saveState(state);
}

// ============================================
// ⏰ 스케줄러
// ============================================
async function startProjectMoonScheduler(client) {
  console.log('🌙 Project Moon 알림 스케줄러 시작 (5분 간격)');

  // 시작 전 현재 상태 동기화 (중복 알림 방지)
  await syncCurrent();

  scheduledTask = cron.schedule('*/5 * * * *', async () => {
    await Promise.all([checkYouTube(client), checkChzzkLive(client)]);
  });
}

function stopProjectMoonScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    console.log('⏹️ Project Moon 알림 스케줄러 중지됨');
  }
}

module.exports = {
  startProjectMoonScheduler,
  stopProjectMoonScheduler,
  checkYouTube,
  checkChzzkLive,
  fetchLatestVideo,
  PM_YOUTUBE_CHANNEL_ID,
  PM_CHZZK_CHANNEL_ID,
};
