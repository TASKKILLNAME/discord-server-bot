const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { EmbedBuilder } = require('discord.js');

const DATA_FILE = path.join(__dirname, '../../data/events.json');

// ============================================
// 데이터 관리
// ============================================

function loadEvents() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('이벤트 데이터 로드 실패:', err.message);
  }
  return {};
}

function saveEvents(events) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(events, null, 2));
  } catch (err) {
    console.error('이벤트 데이터 저장 실패:', err.message);
  }
}

/**
 * 이벤트 생성
 */
function createEvent({ guildId, channelId, messageId, creatorId, creatorName, title, description, datetime, repeat }) {
  const events = loadEvents();
  const eventId = `evt_${Date.now()}`;

  events[eventId] = {
    id: eventId,
    guildId,
    channelId,
    messageId,
    creatorId,
    creatorName,
    title,
    description: description || '',
    datetime, // ISO string
    repeat: repeat || 'none', // none, daily, weekly
    participants: [],
    notified: false,
    createdAt: new Date().toISOString(),
  };

  saveEvents(events);
  return events[eventId];
}

/**
 * 이벤트 참가/취소 토글
 */
function toggleParticipant(eventId, userId, userName) {
  const events = loadEvents();
  const event = events[eventId];
  if (!event) return null;

  const idx = event.participants.findIndex((p) => p.id === userId);
  if (idx >= 0) {
    event.participants.splice(idx, 1);
  } else {
    event.participants.push({ id: userId, name: userName, joinedAt: new Date().toISOString() });
  }

  saveEvents(events);
  return event;
}

/**
 * 이벤트 삭제
 */
function deleteEvent(eventId) {
  const events = loadEvents();
  if (!events[eventId]) return false;
  delete events[eventId];
  saveEvents(events);
  return true;
}

/**
 * 서버의 이벤트 목록
 */
function getGuildEvents(guildId) {
  const events = loadEvents();
  return Object.values(events)
    .filter((e) => e.guildId === guildId)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

/**
 * 이벤트 조회
 */
function getEvent(eventId) {
  const events = loadEvents();
  return events[eventId] || null;
}

/**
 * 이벤트 Embed 생성
 */
function createEventEmbed(event) {
  const eventDate = new Date(event.datetime);
  const now = new Date();
  const isPast = eventDate < now;

  const participantList =
    event.participants.length > 0
      ? event.participants.map((p, i) => `${i + 1}. ${p.name}`).join('\n')
      : '아직 참가자가 없습니다';

  const repeatText = {
    none: '없음',
    daily: '🔁 매일 반복',
    weekly: '🔁 매주 반복',
  };

  const embed = new EmbedBuilder()
    .setTitle(`📅 ${event.title}`)
    .setColor(isPast ? 0x747f8d : 0x5865f2)
    .addFields(
      {
        name: '📝 설명',
        value: event.description || '설명 없음',
      },
      {
        name: '🕐 일시',
        value: `<t:${Math.floor(eventDate.getTime() / 1000)}:F>\n(<t:${Math.floor(eventDate.getTime() / 1000)}:R>)`,
      },
      {
        name: '🔄 반복',
        value: repeatText[event.repeat] || '없음',
        inline: true,
      },
      {
        name: `✅ 참가자 (${event.participants.length}명)`,
        value: participantList,
      },
      {
        name: '👤 생성자',
        value: event.creatorName,
        inline: true,
      }
    )
    .setFooter({ text: `이벤트 ID: ${event.id}` })
    .setTimestamp(eventDate);

  if (isPast && event.repeat === 'none') {
    embed.setDescription('⏰ 이 이벤트는 이미 종료되었습니다.');
  }

  return embed;
}

// ============================================
// 알림 스케줄러
// ============================================

let reminderTask = null;

function startEventScheduler(client) {
  console.log('📅 이벤트 알림 스케줄러 시작 (1분 간격 체크)');

  // 1분마다 체크
  reminderTask = cron.schedule('* * * * *', async () => {
    await checkAndNotify(client);
  });
}

async function checkAndNotify(client) {
  const events = loadEvents();
  const now = new Date();
  let changed = false;

  for (const event of Object.values(events)) {
    const eventDate = new Date(event.datetime);
    const diffMs = eventDate.getTime() - now.getTime();
    const diffMin = diffMs / (1000 * 60);

    // 5분 전 알림 (4~6분 범위)
    if (diffMin > 4 && diffMin <= 6 && !event.notified) {
      console.log(`🔔 이벤트 알림 전송: ${event.title}`);

      for (const participant of event.participants) {
        try {
          const user = await client.users.fetch(participant.id);
          if (user) {
            const dmEmbed = new EmbedBuilder()
              .setTitle('🔔 이벤트 알림!')
              .setDescription(`**${event.title}**이(가) 5분 후에 시작됩니다!`)
              .addFields(
                {
                  name: '📝 설명',
                  value: event.description || '설명 없음',
                },
                {
                  name: '🕐 시작 시간',
                  value: `<t:${Math.floor(eventDate.getTime() / 1000)}:F>`,
                },
                {
                  name: `✅ 참가자 ${event.participants.length}명`,
                  value: event.participants.map((p) => p.name).join(', '),
                }
              )
              .setColor(0xff9900)
              .setTimestamp();

            await user.send({ embeds: [dmEmbed] });
            console.log(`  📩 ${participant.name}에게 DM 전송 완료`);
          }
        } catch (err) {
          console.error(`  ❌ ${participant.name} DM 전송 실패:`, err.message);
        }
      }

      // 채널에도 알림
      try {
        const channel = await client.channels.fetch(event.channelId);
        if (channel) {
          const channelEmbed = new EmbedBuilder()
            .setTitle('🔔 이벤트 5분 전!')
            .setDescription(
              `**${event.title}**이(가) 곧 시작됩니다!\n\n` +
              event.participants.map((p) => `<@${p.id}>`).join(' ')
            )
            .setColor(0xff9900)
            .setTimestamp();

          await channel.send({ embeds: [channelEmbed] });
        }
      } catch (err) {
        console.error('채널 알림 전송 실패:', err.message);
      }

      event.notified = true;
      changed = true;
    }

    // 이벤트 종료 후 처리 (30분 지남)
    if (diffMin < -30 && event.notified) {
      if (event.repeat === 'daily') {
        // 다음 날로 이동
        const next = new Date(eventDate);
        next.setDate(next.getDate() + 1);
        event.datetime = next.toISOString();
        event.notified = false;
        changed = true;
        console.log(`🔁 일일 반복 이벤트 갱신: ${event.title} → ${next.toLocaleString('ko-KR')}`);
      } else if (event.repeat === 'weekly') {
        // 다음 주로 이동
        const next = new Date(eventDate);
        next.setDate(next.getDate() + 7);
        event.datetime = next.toISOString();
        event.notified = false;
        changed = true;
        console.log(`🔁 주간 반복 이벤트 갱신: ${event.title} → ${next.toLocaleString('ko-KR')}`);
      }
      // repeat === 'none' 이면 그냥 둠 (수동 삭제)
    }
  }

  if (changed) saveEvents(events);
}

function stopEventScheduler() {
  if (reminderTask) {
    reminderTask.stop();
    console.log('⏹️ 이벤트 스케줄러 중지됨');
  }
}

module.exports = {
  createEvent,
  toggleParticipant,
  deleteEvent,
  getGuildEvents,
  getEvent,
  createEventEmbed,
  startEventScheduler,
  stopEventScheduler,
  loadEvents,
};