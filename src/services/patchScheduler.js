const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { checkForNewPatch, getLatestPatchUrl, loadLastPatch, saveLastPatch } = require('./patchCrawler');
const { summarizePatchNotes, formatForDiscord } = require('./aiSummarizer');
const { EmbedBuilder } = require('discord.js');

let scheduledTask = null;

const PATCH_CHANNELS_FILE = path.join(__dirname, '../../data/patchChannels.json');

// ============================================
// 📁 서버별 패치 채널 데이터 관리
// ============================================
function loadPatchChannels() {
  try {
    if (fs.existsSync(PATCH_CHANNELS_FILE)) {
      const data = fs.readFileSync(PATCH_CHANNELS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('패치 채널 데이터 로드 오류:', err);
  }
  return {};
}

function savePatchChannels(data) {
  try {
    const dir = path.dirname(PATCH_CHANNELS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(PATCH_CHANNELS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('패치 채널 데이터 저장 오류:', err);
  }
}

function setPatchChannel(guildId, channelId) {
  const data = loadPatchChannels();
  data[guildId] = { channelId, setAt: new Date().toISOString() };
  savePatchChannels(data);
}

function removePatchChannel(guildId) {
  const data = loadPatchChannels();
  delete data[guildId];
  savePatchChannels(data);
}

function getPatchChannel(guildId) {
  const data = loadPatchChannels();
  return data[guildId]?.channelId || null;
}

function getAllPatchChannels() {
  const data = loadPatchChannels();
  return Object.entries(data).map(([guildId, info]) => ({
    guildId,
    channelId: info.channelId,
  }));
}

// ============================================
// 🔄 패치노트 자동 체크 스케줄러
// ============================================

/**
 * 패치노트 자동 체크 스케줄러 시작
 * 기본: 30분마다 확인, 모든 등록된 서버에 알림
 */
async function startPatchScheduler(client) {
  // 기존 .env 호환: LOL_PATCH_CHANNEL_ID가 있으면 자동 마이그레이션
  const legacyChannelId = process.env.LOL_PATCH_CHANNEL_ID;
  if (legacyChannelId) {
    const existing = loadPatchChannels();
    const alreadyMigrated = Object.values(existing).some(
      (info) => info.channelId === legacyChannelId
    );
    if (!alreadyMigrated) {
      // .env의 채널이 속한 서버를 찾아서 저장
      const channel = client.channels.cache.get(legacyChannelId);
      if (channel?.guild) {
        setPatchChannel(channel.guild.id, legacyChannelId);
        console.log(`📦 기존 패치 채널 마이그레이션: ${channel.guild.name} → #${channel.name}`);
      }
    }
  }

  const channels = getAllPatchChannels();

  if (channels.length === 0) {
    console.log('⚠️ 패치노트 알림 채널이 설정된 서버가 없습니다.');
    console.log('   각 서버에서 /패치노트 설정 명령어로 채널을 설정해주세요.');
  } else {
    console.log(`🔄 롤 패치노트 자동 체크 스케줄러 시작 (30분 간격, ${channels.length}개 서버)`);
  }

  // ✅ cron 시작 전에 반드시 현재 패치 동기화 (재배포 시 중복 알림 방지)
  console.log('🔍 초기 패치노트 동기화 (알림 없음)...');
  await syncCurrentPatch();

  // 30분마다 체크 (*/30 * * * *)
  scheduledTask = cron.schedule('*/30 * * * *', async () => {
    console.log(`\n⏰ [${new Date().toLocaleString('ko-KR')}] 패치노트 체크 중...`);
    await checkAndNotifyAll(client);
  });
}

/**
 * 현재 최신 패치를 기록만 하고 알림은 보내지 않음 (재시작 시 중복 알림 방지)
 * Railway 재배포 시 data/ 파일이 사라지므로 매번 강제로 현재 패치를 기록
 */
async function syncCurrentPatch() {
  try {
    const latest = await getLatestPatchUrl();
    if (latest.url) {
      const lastPatch = loadLastPatch();
      if (lastPatch.lastUrl === latest.url) {
        console.log(`📋 패치 기록 최신 상태: ${lastPatch.lastTitle || latest.url}`);
        return;
      }
      saveLastPatch({
        lastUrl: latest.url,
        lastTitle: latest.title || '패치노트',
        checkedAt: new Date().toISOString(),
      });
      console.log(`📋 현재 패치 기록 완료: ${latest.title || latest.url} (알림 없음)`);
    } else {
      console.log('⚠️ 패치노트 URL을 가져올 수 없어 동기화 스킵');
    }
  } catch (err) {
    console.error('패치 동기화 실패:', err.message);
  }
}

/**
 * 모든 등록된 서버에 패치노트 알림 전송
 */
async function checkAndNotifyAll(client) {
  try {
    const patchData = await checkForNewPatch();

    if (!patchData) {
      return; // 새 패치 없음
    }

    console.log(`📰 새 패치노트 감지: ${patchData.title}`);
    console.log('🤖 AI 요약 생성 중...');

    // AI 요약 (한 번만 생성)
    const summary = await summarizePatchNotes(patchData);
    const embedData = formatForDiscord(summary, patchData);

    // 모든 등록된 서버에 전송
    const channels = getAllPatchChannels();
    let successCount = 0;
    let failCount = 0;

    for (const { guildId, channelId } of channels) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
          console.error(`❌ 채널을 찾을 수 없음: ${channelId} (서버: ${guildId})`);
          failCount++;
          continue;
        }

        await sendPatchEmbeds(channel, embedData, patchData);
        successCount++;
      } catch (err) {
        console.error(`❌ 패치 알림 실패 (서버: ${guildId}):`, err.message);
        failCount++;
      }
    }

    console.log(`✅ 패치노트 알림 전송 완료! (성공: ${successCount}, 실패: ${failCount})`);
  } catch (err) {
    console.error('❌ 패치노트 체크 실패:', err.message);
  }
}

/**
 * 채널에 패치노트 Embed 전송 (내부 헬퍼)
 */
async function sendPatchEmbeds(channel, embedData, patchData) {
  // 메인 알림 Embed
  const alertEmbed = new EmbedBuilder()
    .setTitle('🔔 새로운 롤 패치노트가 발표되었습니다!')
    .setDescription('AI가 패치노트를 분석하고 요약했습니다.')
    .setColor(0xff4444)
    .setTimestamp();

  await channel.send({ embeds: [alertEmbed] });

  // 패치노트 요약 Embed
  const patchEmbed = new EmbedBuilder()
    .setTitle(embedData.title)
    .setURL(embedData.url)
    .setColor(embedData.color)
    .setTimestamp()
    .setFooter(embedData.footer);

  if (embedData.thumbnail) {
    patchEmbed.setThumbnail(embedData.thumbnail.url);
  }

  // 필드가 25개 초과하면 분할 (Discord 제한)
  const maxFieldsPerEmbed = 25;
  const fieldChunks = [];
  for (let i = 0; i < embedData.fields.length; i += maxFieldsPerEmbed) {
    fieldChunks.push(embedData.fields.slice(i, i + maxFieldsPerEmbed));
  }

  // 첫 번째 Embed에 필드 추가
  if (fieldChunks.length > 0) {
    for (const field of fieldChunks[0]) {
      patchEmbed.addFields(field);
    }
    await channel.send({ embeds: [patchEmbed] });
  }

  // 나머지 필드는 추가 Embed로
  for (let i = 1; i < fieldChunks.length; i++) {
    const extraEmbed = new EmbedBuilder().setColor(embedData.color);
    for (const field of fieldChunks[i]) {
      extraEmbed.addFields(field);
    }
    await channel.send({ embeds: [extraEmbed] });
  }

  // 원문 링크
  await channel.send(`📎 **원문 보기:** ${patchData.url}`);
}

/**
 * 특정 채널에 패치노트 전송 (명령어용)
 */
async function sendPatchToChannel(channel, patchData) {
  console.log('🤖 AI 요약 생성 중...');

  const summary = await summarizePatchNotes(patchData);
  const embedData = formatForDiscord(summary, patchData);

  const patchEmbed = new EmbedBuilder()
    .setTitle(embedData.title)
    .setURL(embedData.url)
    .setColor(embedData.color)
    .setTimestamp()
    .setFooter(embedData.footer);

  if (embedData.thumbnail) {
    patchEmbed.setThumbnail(embedData.thumbnail.url);
  }

  for (const field of embedData.fields.slice(0, 25)) {
    patchEmbed.addFields(field);
  }

  await channel.send({ embeds: [patchEmbed] });
  await channel.send(`📎 **원문 보기:** ${patchData.url}`);
}

/**
 * 스케줄러 중지
 */
function stopPatchScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    console.log('⏹️ 패치노트 스케줄러 중지됨');
  }
}

module.exports = {
  startPatchScheduler,
  stopPatchScheduler,
  checkAndNotifyAll,
  sendPatchToChannel,
  loadPatchChannels,
  savePatchChannels,
  setPatchChannel,
  removePatchChannel,
  getPatchChannel,
  getAllPatchChannels,
};
