const cron = require('node-cron');
const { checkForNewPatch } = require('./patchCrawler');
const { summarizePatchNotes, formatForDiscord } = require('./aiSummarizer');
const { EmbedBuilder } = require('discord.js');

let scheduledTask = null;

/**
 * 패치노트 자동 체크 스케줄러 시작
 * 기본: 30분마다 확인
 */
function startPatchScheduler(client) {
  const channelId = process.env.LOL_PATCH_CHANNEL_ID;

  if (!channelId) {
    console.log('⚠️ LOL_PATCH_CHANNEL_ID가 설정되지 않았습니다. 패치노트 자동 알림이 비활성화됩니다.');
    console.log('   /패치노트 설정 명령어로 채널을 설정하거나 .env에 추가해주세요.');
    return;
  }

  console.log('🔄 롤 패치노트 자동 체크 스케줄러 시작 (30분 간격)');

  // 30분마다 체크 (*/30 * * * *)
  scheduledTask = cron.schedule('*/30 * * * *', async () => {
    console.log(`\n⏰ [${new Date().toLocaleString('ko-KR')}] 패치노트 체크 중...`);
    await checkAndNotify(client, channelId);
  });

  // 봇 시작 시 1분 후 첫 체크
  setTimeout(async () => {
    console.log('🔍 초기 패치노트 체크...');
    await checkAndNotify(client, channelId);
  }, 60000);
}

/**
 * 패치노트 확인 및 알림 전송
 */
async function checkAndNotify(client, channelId) {
  try {
    const patchData = await checkForNewPatch();

    if (!patchData) {
      return; // 새 패치 없음
    }

    console.log(`📰 새 패치노트 감지: ${patchData.title}`);
    console.log('🤖 AI 요약 생성 중...');

    // AI 요약
    const summary = await summarizePatchNotes(patchData);

    // 디스코드 Embed 형식으로 변환
    const embedData = formatForDiscord(summary, patchData);

    // 채널 가져오기
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      console.error(`❌ 채널을 찾을 수 없습니다: ${channelId}`);
      return;
    }

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

    console.log('✅ 패치노트 알림 전송 완료!');
  } catch (err) {
    console.error('❌ 패치노트 알림 실패:', err.message);
  }
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
  checkAndNotify,
  sendPatchToChannel,
};