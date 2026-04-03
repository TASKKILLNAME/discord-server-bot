const { EmbedBuilder, ActivityType } = require('discord.js');

const ADMIN_CHANNEL_ID = '1482299763344019477';
const UPDATE_INTERVAL = 60 * 1000; // 1분마다 갱신

let trackerMessage = null;
let intervalId = null;

/**
 * 활동 감시 시작
 */
async function startTracker(client) {
  const channel = client.channels.cache.get(ADMIN_CHANNEL_ID);
  if (!channel) {
    console.warn('⚠️ 활동 감시 채널을 찾을 수 없습니다:', ADMIN_CHANNEL_ID);
    return;
  }

  // 기존 봇 메시지 찾기 (재시작 시 재사용)
  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    trackerMessage = messages.find(
      (m) => m.author.id === client.user.id && m.embeds[0]?.title === '🎮 실시간 활동 현황'
    );
  } catch {}

  // 즉시 한번 업데이트
  await updateTracker(client);

  // 주기적 업데이트
  intervalId = setInterval(() => updateTracker(client), UPDATE_INTERVAL);
  console.log('👁️ 활동 감시 시작 (1분 간격)');
}

/**
 * 현황 업데이트
 */
async function updateTracker(client) {
  const channel = client.channels.cache.get(ADMIN_CHANNEL_ID);
  if (!channel) return;

  const guild = channel.guild;
  if (!guild) return;

  // 모든 멤버의 활동 수집
  const activities = new Map(); // gameName → [{ member, detail }]

  for (const [, member] of guild.members.cache) {
    if (member.user.bot) continue;

    const presence = member.presence;
    if (!presence || presence.status === 'offline') continue;

    for (const activity of presence.activities) {
      if (activity.type === ActivityType.Playing) {
        const gameName = activity.name;
        if (!activities.has(gameName)) activities.set(gameName, []);
        activities.get(gameName).push({
          name: member.displayName,
          detail: activity.details || activity.state || null,
        });
      }
      if (activity.type === ActivityType.Streaming) {
        const label = `🔴 ${activity.name || '스트리밍'}`;
        if (!activities.has(label)) activities.set(label, []);
        activities.get(label).push({
          name: member.displayName,
          detail: activity.details || activity.state || null,
        });
      }
    }
  }

  // 온라인 (게임 안 하는) 멤버 수
  const onlineCount = guild.members.cache.filter(
    (m) => !m.user.bot && m.presence && m.presence.status !== 'offline'
  ).size;
  const gamingCount = new Set(
    [...activities.values()].flat().map((a) => a.name)
  ).size;

  // 임베드 생성
  const embed = new EmbedBuilder()
    .setTitle('🎮 실시간 활동 현황')
    .setColor(0x5865F2)
    .setFooter({ text: `온라인 ${onlineCount}명 · 게임 중 ${gamingCount}명 · 1분마다 갱신` })
    .setTimestamp();

  if (activities.size === 0) {
    embed.setDescription('현재 게임 중인 멤버가 없습니다.');
  } else {
    // 인원 많은 게임 순으로 정렬
    const sorted = [...activities.entries()].sort((a, b) => b[1].length - a[1].length);

    const fields = [];
    for (const [game, players] of sorted) {
      const playerList = players
        .map((p) => p.detail ? `${p.name} _${p.detail}_` : p.name)
        .join('\n');
      fields.push({
        name: `${game} (${players.length}명)`,
        value: playerList || '-',
        inline: true,
      });
    }

    // Discord 임베드 필드 최대 25개
    embed.addFields(fields.slice(0, 25));
  }

  try {
    if (trackerMessage) {
      await trackerMessage.edit({ embeds: [embed] });
    } else {
      trackerMessage = await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    // 메시지가 삭제됐으면 새로 보내기
    try {
      trackerMessage = await channel.send({ embeds: [embed] });
    } catch {}
  }
}

module.exports = { startTracker };
