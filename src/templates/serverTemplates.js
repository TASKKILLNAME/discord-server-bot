// 서버 템플릿 정의
// 각 템플릿은 카테고리, 채널, 역할, 권한을 포함

const { PermissionFlagsBits, ChannelType } = require('discord.js');

const templates = {
  // ============================================
  // 🎮 게임 커뮤니티 서버
  // ============================================
  gaming: {
    name: '🎮 게임 커뮤니티',
    description: '게임 커뮤니티를 위한 서버 구성',
    roles: [
      {
        name: '👑 서버장',
        color: '#FFD700',
        hoist: true,
        permissions: [PermissionFlagsBits.Administrator],
        position: 'highest',
      },
      {
        name: '🛡️ 관리자',
        color: '#FF6B6B',
        hoist: true,
        permissions: [
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageRoles,
          PermissionFlagsBits.KickMembers,
          PermissionFlagsBits.BanMembers,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.MuteMembers,
          PermissionFlagsBits.DeafenMembers,
          PermissionFlagsBits.MoveMembers,
        ],
      },
      {
        name: '⚔️ 모더레이터',
        color: '#4ECDC4',
        hoist: true,
        permissions: [
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.KickMembers,
          PermissionFlagsBits.MuteMembers,
        ],
      },
      {
        name: '🎮 게이머',
        color: '#45B7D1',
        hoist: true,
        permissions: [],
      },
      {
        name: '🆕 뉴비',
        color: '#96CEB4',
        hoist: false,
        permissions: [],
      },
    ],
    categories: [
      {
        name: '📢 공지사항',
        channels: [
          { name: '📋-규칙', type: ChannelType.GuildText, readOnly: true },
          { name: '📢-공지', type: ChannelType.GuildText, readOnly: true },
          { name: '🔔-업데이트', type: ChannelType.GuildText, readOnly: true },
        ],
      },
      {
        name: '💬 일반 채팅',
        channels: [
          { name: '💬-자유채팅', type: ChannelType.GuildText },
          { name: '🎉-인사해요', type: ChannelType.GuildText },
          { name: '📸-짤-공유', type: ChannelType.GuildText },
          { name: '🤖-봇-명령어', type: ChannelType.GuildText },
        ],
      },
      {
        name: '🎮 게임 채팅',
        channels: [
          { name: '🎮-롤', type: ChannelType.GuildText },
          { name: '🔫-발로란트', type: ChannelType.GuildText },
          { name: '🏝️-마인크래프트', type: ChannelType.GuildText },
          { name: '🎲-기타게임', type: ChannelType.GuildText },
          { name: '📊-전적검색', type: ChannelType.GuildText },
        ],
      },
      {
        name: '🔊 음성 채널',
        channels: [
          { name: '🔊 자유 음성 1', type: ChannelType.GuildVoice },
          { name: '🔊 자유 음성 2', type: ChannelType.GuildVoice },
          { name: '🎮 게임 음성 1', type: ChannelType.GuildVoice },
          { name: '🎮 게임 음성 2', type: ChannelType.GuildVoice },
          { name: '🔇 AFK', type: ChannelType.GuildVoice },
        ],
      },
    ],
  },

  // ============================================
  // 📚 스터디/학습 서버
  // ============================================
  study: {
    name: '📚 스터디 그룹',
    description: '스터디 및 학습 그룹을 위한 서버 구성',
    roles: [
      {
        name: '📚 스터디장',
        color: '#E74C3C',
        hoist: true,
        permissions: [PermissionFlagsBits.Administrator],
        position: 'highest',
      },
      {
        name: '📝 멘토',
        color: '#3498DB',
        hoist: true,
        permissions: [
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ManageChannels,
        ],
      },
      {
        name: '🎓 스터디원',
        color: '#2ECC71',
        hoist: true,
        permissions: [],
      },
      {
        name: '👀 청강생',
        color: '#95A5A6',
        hoist: false,
        permissions: [],
      },
    ],
    categories: [
      {
        name: '📢 안내',
        channels: [
          { name: '📋-규칙-및-안내', type: ChannelType.GuildText, readOnly: true },
          { name: '📅-스케줄', type: ChannelType.GuildText, readOnly: true },
          { name: '📢-공지', type: ChannelType.GuildText, readOnly: true },
        ],
      },
      {
        name: '📖 학습',
        channels: [
          { name: '📖-자료공유', type: ChannelType.GuildText },
          { name: '❓-질문답변', type: ChannelType.GuildText },
          { name: '💡-TIL', type: ChannelType.GuildText },
          { name: '🔗-링크모음', type: ChannelType.GuildText },
        ],
      },
      {
        name: '💬 소통',
        channels: [
          { name: '💬-자유채팅', type: ChannelType.GuildText },
          { name: '🎯-목표선언', type: ChannelType.GuildText },
          { name: '✅-인증', type: ChannelType.GuildText },
          { name: '🗳️-투표', type: ChannelType.GuildText },
        ],
      },
      {
        name: '🔊 음성',
        channels: [
          { name: '📖 스터디룸 1', type: ChannelType.GuildVoice },
          { name: '📖 스터디룸 2', type: ChannelType.GuildVoice },
          { name: '💬 잡담방', type: ChannelType.GuildVoice },
        ],
      },
    ],
  },

  // ============================================
  // 🏢 프로젝트/팀 서버
  // ============================================
  project: {
    name: '🏢 프로젝트 팀',
    description: '개발 프로젝트 팀을 위한 서버 구성',
    roles: [
      {
        name: '👑 PM',
        color: '#E74C3C',
        hoist: true,
        permissions: [PermissionFlagsBits.Administrator],
        position: 'highest',
      },
      {
        name: '💻 Backend',
        color: '#3498DB',
        hoist: true,
        permissions: [],
      },
      {
        name: '🎨 Frontend',
        color: '#E67E22',
        hoist: true,
        permissions: [],
      },
      {
        name: '🎯 Designer',
        color: '#9B59B6',
        hoist: true,
        permissions: [],
      },
      {
        name: '📋 QA',
        color: '#1ABC9C',
        hoist: true,
        permissions: [],
      },
    ],
    categories: [
      {
        name: '📢 프로젝트 안내',
        channels: [
          { name: '📋-프로젝트-개요', type: ChannelType.GuildText, readOnly: true },
          { name: '📢-공지사항', type: ChannelType.GuildText, readOnly: true },
          { name: '📅-일정', type: ChannelType.GuildText, readOnly: true },
          { name: '📌-컨벤션', type: ChannelType.GuildText, readOnly: true },
        ],
      },
      {
        name: '💻 개발',
        channels: [
          { name: '💻-백엔드', type: ChannelType.GuildText },
          { name: '🎨-프론트엔드', type: ChannelType.GuildText },
          { name: '🗄️-데이터베이스', type: ChannelType.GuildText },
          { name: '🐛-버그리포트', type: ChannelType.GuildText },
          { name: '🔀-git-로그', type: ChannelType.GuildText },
          { name: '🚀-배포', type: ChannelType.GuildText },
        ],
      },
      {
        name: '📝 기획/디자인',
        channels: [
          { name: '📝-기획문서', type: ChannelType.GuildText },
          { name: '🎯-디자인', type: ChannelType.GuildText },
          { name: '💡-아이디어', type: ChannelType.GuildText },
        ],
      },
      {
        name: '💬 소통',
        channels: [
          { name: '💬-자유채팅', type: ChannelType.GuildText },
          { name: '📸-짤방', type: ChannelType.GuildText },
          { name: '🤖-봇', type: ChannelType.GuildText },
        ],
      },
      {
        name: '🔊 음성',
        channels: [
          { name: '💻 개발 회의', type: ChannelType.GuildVoice },
          { name: '📋 스크럼', type: ChannelType.GuildVoice },
          { name: '💬 잡담', type: ChannelType.GuildVoice },
        ],
      },
    ],
  },

  // ============================================
  // 🎵 음악/취미 커뮤니티 서버
  // ============================================
  community: {
    name: '🎵 커뮤니티',
    description: '취미/관심사 커뮤니티를 위한 서버 구성',
    roles: [
      {
        name: '👑 운영진',
        color: '#FFD700',
        hoist: true,
        permissions: [PermissionFlagsBits.Administrator],
        position: 'highest',
      },
      {
        name: '🛡️ 스태프',
        color: '#FF6B6B',
        hoist: true,
        permissions: [
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.KickMembers,
          PermissionFlagsBits.MuteMembers,
        ],
      },
      {
        name: '⭐ VIP',
        color: '#F1C40F',
        hoist: true,
        permissions: [],
      },
      {
        name: '🎵 멤버',
        color: '#3498DB',
        hoist: false,
        permissions: [],
      },
    ],
    categories: [
      {
        name: '📢 공지',
        channels: [
          { name: '📋-규칙', type: ChannelType.GuildText, readOnly: true },
          { name: '📢-공지사항', type: ChannelType.GuildText, readOnly: true },
          { name: '🎉-이벤트', type: ChannelType.GuildText, readOnly: true },
        ],
      },
      {
        name: '💬 커뮤니티',
        channels: [
          { name: '💬-자유채팅', type: ChannelType.GuildText },
          { name: '🎉-가입인사', type: ChannelType.GuildText },
          { name: '📸-사진공유', type: ChannelType.GuildText },
          { name: '🎵-음악추천', type: ChannelType.GuildText },
          { name: '🎬-영화드라마', type: ChannelType.GuildText },
          { name: '🍔-맛집', type: ChannelType.GuildText },
        ],
      },
      {
        name: '🎉 즐길거리',
        channels: [
          { name: '🎮-게임', type: ChannelType.GuildText },
          { name: '🎨-그림', type: ChannelType.GuildText },
          { name: '📝-글쓰기', type: ChannelType.GuildText },
          { name: '🤖-봇놀이', type: ChannelType.GuildText },
        ],
      },
      {
        name: '🔊 음성',
        channels: [
          { name: '🔊 수다방 1', type: ChannelType.GuildVoice },
          { name: '🔊 수다방 2', type: ChannelType.GuildVoice },
          { name: '🎵 노래방', type: ChannelType.GuildVoice },
          { name: '🎮 게임방', type: ChannelType.GuildVoice },
        ],
      },
    ],
  },

  // ============================================
  // 🏪 비즈니스/쇼핑몰 서버
  // ============================================
  business: {
    name: '🏪 비즈니스',
    description: '비즈니스/브랜드 커뮤니티를 위한 서버 구성',
    roles: [
      {
        name: '👑 대표',
        color: '#FFD700',
        hoist: true,
        permissions: [PermissionFlagsBits.Administrator],
        position: 'highest',
      },
      {
        name: '💼 직원',
        color: '#3498DB',
        hoist: true,
        permissions: [
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ManageChannels,
        ],
      },
      {
        name: '⭐ VIP 고객',
        color: '#F1C40F',
        hoist: true,
        permissions: [],
      },
      {
        name: '🛒 고객',
        color: '#95A5A6',
        hoist: false,
        permissions: [],
      },
    ],
    categories: [
      {
        name: '📢 안내',
        channels: [
          { name: '📋-이용안내', type: ChannelType.GuildText, readOnly: true },
          { name: '📢-공지사항', type: ChannelType.GuildText, readOnly: true },
          { name: '🎉-이벤트-프로모션', type: ChannelType.GuildText, readOnly: true },
        ],
      },
      {
        name: '🛒 쇼핑',
        channels: [
          { name: '🆕-신상품', type: ChannelType.GuildText, readOnly: true },
          { name: '💰-할인정보', type: ChannelType.GuildText, readOnly: true },
          { name: '⭐-리뷰', type: ChannelType.GuildText },
          { name: '❓-상품문의', type: ChannelType.GuildText },
        ],
      },
      {
        name: '💬 고객소통',
        channels: [
          { name: '💬-자유게시판', type: ChannelType.GuildText },
          { name: '🎫-1대1-문의', type: ChannelType.GuildText },
          { name: '📢-건의사항', type: ChannelType.GuildText },
          { name: '📸-인증샷', type: ChannelType.GuildText },
        ],
      },
      {
        name: '🔒 직원 전용',
        channels: [
          { name: '💼-업무채팅', type: ChannelType.GuildText, staffOnly: true },
          { name: '📊-매출현황', type: ChannelType.GuildText, staffOnly: true },
          { name: '📋-주문관리', type: ChannelType.GuildText, staffOnly: true },
        ],
      },
    ],
  },
};

module.exports = templates;