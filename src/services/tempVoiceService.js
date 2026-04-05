const { ChannelType, PermissionFlagsBits } = require('discord.js');

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
  isRoomOwner,
  isTempChannel,
  findExistingRoom,
  cleanupTempChannels,
  TRIGGER_NAME,
};
