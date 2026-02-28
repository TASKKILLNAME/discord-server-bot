const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { checkForNewPatch, getLatestPatchUrl, loadLastPatch, saveLastPatch } = require('./valorantCrawler');
const { summarizeValorantPatchNotes, formatValorantForDiscord } = require('./aiSummarizer');
const { EmbedBuilder } = require('discord.js');

let scheduledTask = null;

const PATCH_CHANNELS_FILE = path.join(__dirname, '../../data/valorantPatchChannels.json');

// ============================================
// 📁 서버별 Valorant 패치 채널 데이터 관리
// ============================================
function loadPatchChannels() {
  try {
    if (fs.existsSync(PATCH_CHANNELS_FILE)) {
      return JSON.parse(fs.readFileSync(PATCH_CHANNELS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Valorant 패치 채널 데이터 로드 오류:', err);
  }
  return {};
}

function savePatchChannels(data) {
  try {
    const dir = path.dirname(PATCH_CHANNELS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PATCH_CHANNELS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Valorant 패치 채널 데이터 저장 오류:', err);
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
  return loadPatchChannels()[guildId]?.channelId || null;
}

function getAllPatchChannels() {
  return Object.entries(loadPatchChannels()).map(([guildId, info]) => ({
    guildId,
    channelId: info.channelId,
  }));
}

// ============================================
// 🔄 Valorant 패치노트 자동 체크 스케줄러
// ============================================

async function startValorantScheduler(client) {
  const channels = getAllPatchChannels();

  if (channels.length === 0) {
    console.log('⚠️ Valorant 패치노트 알림 채널이 설정된 서버가 없습니다.');
  } else {
    console.log(`🔫 Valorant 패치노트 자동 체크 스케줄러 시작 (30분 간격, ${channels.length}개 서버)`);
  }

  // ✅ 시작 전 현재 패치 동기화 (봇 재시작 시 중복 알림 방지)
  console.log('🔍 Valorant 초기 패치노트 동기화 (알림 없음)...');
  await syncCurrentPatch();

  scheduledTask = cron.schedule('*/30 * * * *', async () => {
    console.log(`\n⏰ [${new Date().toLocaleString('ko-KR')}] Valorant 패치노트 체크 중...`);
    await checkAndNotifyAll(client);
  });
}

/**
 * 현재 최신 Valorant 패치를 기록만 하고 알림 없음 (봇 재시작 시 중복 알림 방지)
 */
async function syncCurrentPatch() {
  try {
    const latest = await getLatestPatchUrl();
    if (latest.url) {
      const lastPatch = loadLastPatch();
      if (lastPatch.lastUrl === latest.url) {
        console.log(`📋 Valorant 패치 기록 최신 상태: ${lastPatch.lastTitle || latest.url}`);
        return;
      }
      saveLastPatch({
        lastUrl: latest.url,
        lastTitle: latest.title || 'Valorant 패치노트',
        checkedAt: new Date().toISOString(),
      });
      console.log(`📋 Valorant 현재 패치 기록 완료: ${latest.title || latest.url} (알림 없음)`);
    } else {
      console.log('⚠️ Valorant 패치노트 URL을 가져올 수 없어 동기화 스킵');
    }
  } catch (err) {
    console.error('Valorant 패치 동기화 실패:', err.message);
  }
}

async function checkAndNotifyAll(client) {
  try {
    const patchData = await checkForNewPatch();
    if (!patchData) return;

    console.log(`📰 Valorant 새 패치노트 감지: ${patchData.title}`);
    console.log('🤖 Valorant AI 요약 생성 중...');

    const summary = await summarizeValorantPatchNotes(patchData);
    const embedData = formatValorantForDiscord(summary, patchData);

    const channels = getAllPatchChannels();
    let successCount = 0;
    let failCount = 0;

    for (const { guildId, channelId } of channels) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
          failCount++;
          continue;
        }
        await sendPatchEmbeds(channel, embedData, patchData);
        successCount++;
      } catch (err) {
        console.error(`❌ Valorant 패치 알림 실패 (서버: ${guildId}):`, err.message);
        failCount++;
      }
    }

    console.log(`✅ Valorant 패치노트 알림 전송 완료! (성공: ${successCount}, 실패: ${failCount})`);
  } catch (err) {
    console.error('❌ Valorant 패치노트 체크 실패:', err.message);
  }
}

async function sendPatchEmbeds(channel, embedData, patchData) {
  const alertEmbed = new EmbedBuilder()
    .setTitle('🔔 새로운 발로란트 패치노트가 발표되었습니다!')
    .setDescription('AI가 패치노트를 분석하고 요약했습니다.')
    .setColor(0xff4655)
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

async function sendPatchToChannel(channel, patchData) {
  console.log('🤖 Valorant AI 요약 생성 중...');
  const summary = await summarizeValorantPatchNotes(patchData);
  const embedData = formatValorantForDiscord(summary, patchData);

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
}

function stopValorantScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    console.log('⏹️ Valorant 패치노트 스케줄러 중지됨');
  }
}

module.exports = {
  startValorantScheduler,
  stopValorantScheduler,
  checkAndNotifyAll,
  sendPatchToChannel,
  loadPatchChannels,
  savePatchChannels,
  setPatchChannel,
  removePatchChannel,
  getPatchChannel,
  getAllPatchChannels,
};
