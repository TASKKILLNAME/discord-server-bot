const { ChannelType, PermissionFlagsBits, AuditLogEvent } = require('discord.js');

// 활성 임시 채널 관리 (메모리)
const activeTempChannels = new Map();
// key: channelId → { ownerId, guildId, createdAt }

// 트리거 채널 이름 (이 이름의 음성채널에 입장하면 방 생성)
const TRIGGER_NAME = '➕ 방 만들기';

// 카테고리명 → 방장 역할명 매핑
const CATEGORY_LEADER_MAP = {
  'LOL':       'LOL 방장',
  '발로란트':  '발로란트 방장',
  'APEX':      'apex 방장',
  'PUBG':      'pubg 방장',
  'RAINBOW6':  'rainbow6 방장',
  'TARKOV':    'tarkov 방장',
  '림버스':    '림버스 방장',
};

// 운영진 판별 기준 권한
// 음성 권한(Mute/Deafen/Move)은 방장 역할도 가질 수 있으므로 제외 —
// 서버 운영 권한만으로 판별해야 방장이 운영진으로 오인되지 않는다.
const STAFF_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
];

/**
 * 운영진(서버장/관리자/모더레이터)인지 확인
 * member.permissions 는 역할 기반 길드 권한만 계산 — 채널 오버라이트는 포함되지 않으므로
 * 임시 방 오버라이트로 음소거 권한을 받은 방장은 여기 걸리지 않는다.
 */
function isStaff(member) {
  if (!member) return false;
  if (member.id === member.guild?.ownerId) return true;
  return STAFF_PERMISSIONS.some(p => member.permissions.has(p));
}

/**
 * voiceStateUpdate 이벤트 핸들러
 */
async function handleVoiceStateUpdate(oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  // ── 입장: 트리거 채널 감지 → 임시 방 생성 ──
  if (newState.channel && newState.channel.name === TRIGGER_NAME) {
    await createTempChannel(newState);
  }

  // ── 권한 역전 방지: 방장이 운영진을 음소거하면 자동 해제 ──
  await protectStaffFromVoiceModeration(oldState, newState);

  // ── 퇴장: 임시 채널 비었으면 15초 후 삭제 (재접속 대비) ──
  if (oldState.channel && oldState.channel.members.size === 0) {
    const isTempByMap = activeTempChannels.has(oldState.channelId);
    const isTempByName = oldState.channel.name.startsWith('🔊 ') &&
      (oldState.channel.name.includes('님의 방') || oldState.channel.name.includes('의 '));

    if (isTempByMap || isTempByName) {
      const channelId = oldState.channelId;
      const channel = oldState.channel;
      setTimeout(async () => {
        try {
          const refreshed = channel.guild.channels.cache.get(channelId);
          if (refreshed && refreshed.members.size === 0) {
            await deleteTempChannel(refreshed);
          }
        } catch (e) {}
      }, 15000);
    }
  }
}

/**
 * 자기보다 낮은 사람이 운영진을 서버 음소거/귀막기 하면 자동으로 되돌린다.
 *
 * 디스코드는 Mute/Deafen/Move 에 역할 계층 검사를 하지 않는다 (Kick/Ban/Timeout 과 다름).
 * 게다가 서버 음소거는 클라이언트에서 본인이 직접 해제할 수 없어서,
 * 방장이 관리자를 음소거하면 관리자 쪽에서 되돌릴 방법이 없다. 그 구멍을 봇이 막는다.
 *
 * 동급 이상 운영진이 건 제재는 정당한 조치로 보고 그대로 둔다.
 */
async function protectStaffFromVoiceModeration(oldState, newState) {
  const member = newState.member;
  if (!member || member.user.bot) return;
  if (!newState.channelId) return;

  const mutedNow = newState.serverMute && !oldState.serverMute;
  const deafenedNow = newState.serverDeaf && !oldState.serverDeaf;
  if (!mutedNow && !deafenedNow) return;
  if (!isStaff(member)) return;

  const me = newState.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.MuteMembers)) {
    console.warn('⚠️ 음소거 자동 해제 불가 — 봇에 "멤버 음소거" 권한이 없습니다.');
    return;
  }

  // 감사 로그 기록이 살짝 늦게 붙으므로 잠깐 대기
  await new Promise(r => setTimeout(r, 1200));
  const executor = await findVoiceModerationExecutor(newState.guild, member.id);

  // 본인이 스스로 건 것 → 존중
  if (executor && executor.id === member.id) return;
  // 동급 이상 운영진의 정당한 조치 → 존중
  if (
    executor &&
    isStaff(executor) &&
    executor.roles.highest.position >= member.roles.highest.position
  ) return;

  const patch = { reason: '권한 역전 방지 — 운영진에 대한 음성 제재 자동 해제' };
  if (mutedNow) patch.mute = false;
  if (deafenedNow) patch.deaf = false;

  try {
    await member.voice.edit(patch);

    const who = executor ? executor.user.tag : '알 수 없음';
    const what = mutedNow && deafenedNow ? '음소거/귀막기'
      : mutedNow ? '음소거' : '귀막기';
    console.log(`🛡️ 권한 역전 차단: ${who} → ${member.user.tag} ${what} 자동 해제`);

    try {
      await newState.channel.send(
        `🛡️ ${member} 님은 운영진이라 하위 권한자가 ${what}할 수 없어요. 자동으로 해제했습니다.`
      );
    } catch (e) {}
  } catch (err) {
    console.error('음성 제재 자동 해제 실패:', err.message);
  }
}

/**
 * 감사 로그에서 음소거/귀막기를 건 사람을 찾는다. 못 찾으면 null.
 */
async function findVoiceModerationExecutor(guild, targetId) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;

  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 6 });
    const entry = logs.entries.find(e =>
      e.target?.id === targetId &&
      Date.now() - e.createdTimestamp < 15000 &&
      e.changes?.some(c => c.key === 'mute' || c.key === 'deaf')
    );
    if (!entry?.executor) return null;
    return await guild.members.fetch(entry.executor.id).catch(() => null);
  } catch (err) {
    return null;
  }
}

/**
 * 임시 음성 채널 생성 + 유저 이동
 */
async function createTempChannel(voiceState) {
  const { member, channel, guild } = voiceState;

  // 이미 방을 가지고 있으면 그쪽으로 이동
  const existing = findExistingRoom(member.id);
  if (existing) {
    const existCh = guild.channels.cache.get(existing);
    if (existCh) {
      try { await member.voice.setChannel(existCh); } catch (e) {}
      return;
    }
    activeTempChannels.delete(existing);
  }

  try {
    // 카테고리 기반 이름
    const categoryName = channel.parent?.name || '';
    const gameName = categoryName.replace(/[🎮🔫\s]/g, '').trim();
    const channelName = gameName
      ? `🔊 ${member.displayName}의 ${gameName}`
      : `🔊 ${member.displayName}님의 방`;

    // 해당 카테고리의 방장 역할 찾기
    const leaderOverwrites = [];
    const categoryKey = Object.keys(CATEGORY_LEADER_MAP).find(
      key => categoryName.toUpperCase().includes(key.toUpperCase())
    );
    if (categoryKey) {
      const leaderRoleName = CATEGORY_LEADER_MAP[categoryKey];
      const leaderRole = guild.roles.cache.find(r => r.name === leaderRoleName);
      if (leaderRole) {
        leaderOverwrites.push({
          id: leaderRole.id,
          allow: [
            PermissionFlagsBits.MoveMembers,     // 멤버 이동
            PermissionFlagsBits.MuteMembers,     // 음소거
            PermissionFlagsBits.DeafenMembers,   // 귀막기
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
          ],
        });
      }
    }

    // 임시 채널 생성 (트리거 채널과 같은 카테고리)
    const tempChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: channel.parentId,
      bitrate: 64000,
      permissionOverwrites: [
        // 방 만든 사람 권한
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ManageChannels,  // 이름/제한 변경
            PermissionFlagsBits.MoveMembers,     // 멤버 이동
            PermissionFlagsBits.MuteMembers,     // 음소거
            PermissionFlagsBits.DeafenMembers,   // 귀막기
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
          ],
        },
        // 게임 방장 역할 권한 (관리자보다 낮음 — ManageChannels 없음)
        ...leaderOverwrites,
      ],
      reason: `임시 음성채널 (${member.user.tag})`,
    });

    // Map에 등록
    activeTempChannels.set(tempChannel.id, {
      ownerId: member.id,
      guildId: guild.id,
      createdAt: Date.now(),
    });

    // 유저를 새 채널로 이동
    await member.voice.setChannel(tempChannel);

    console.log(`🔊 임시 방 생성: ${channelName} (by ${member.user.tag})`);
  } catch (err) {
    console.error('임시 방 생성 실패:', err.message);
  }
}

/**
 * 빈 임시 채널 삭제
 */
async function deleteTempChannel(channel) {
  try {
    activeTempChannels.delete(channel.id);
    await channel.delete('임시 음성채널 - 빈 방 자동 삭제');
    console.log(`🗑️ 임시 방 삭제: ${channel.name}`);
  } catch (err) {
    console.error('임시 방 삭제 실패:', err.message);
  }
}

/**
 * 유저의 기존 방 찾기
 */
function findExistingRoom(userId) {
  for (const [channelId, data] of activeTempChannels) {
    if (data.ownerId === userId) return channelId;
  }
  return null;
}

/**
 * 방장인지 확인
 */
function isRoomOwner(channelId, userId) {
  const data = activeTempChannels.get(channelId);
  return data?.ownerId === userId;
}

/**
 * 임시 채널인지 확인
 */
function isTempChannel(channelId) {
  return activeTempChannels.has(channelId);
}

/**
 * 봇 시작 시 빈 임시 채널 정리
 */
async function cleanupTempChannels(client) {
  let cleaned = 0;
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (
        channel.type === ChannelType.GuildVoice &&
        channel.name.startsWith('🔊 ') &&
        channel.members.size === 0 &&
        !channel.name.includes(TRIGGER_NAME)
      ) {
        // 이름 패턴으로 임시 방 판별 (님의 방 / 의 LOL 등)
        if (channel.name.includes('님의 방') || channel.name.includes('의 ')) {
          try {
            await channel.delete('봇 재시작 - 빈 임시 채널 정리');
            cleaned++;
          } catch (e) {}
        }
      }
    }
  }
  if (cleaned > 0) console.log(`🧹 빈 임시 채널 ${cleaned}개 정리 완료`);
}

module.exports = {
  handleVoiceStateUpdate,
  activeTempChannels,
  isStaff,
  isRoomOwner,
  isTempChannel,
  findExistingRoom,
  cleanupTempChannels,
  TRIGGER_NAME,
};
