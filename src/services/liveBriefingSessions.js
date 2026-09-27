const crypto = require('crypto');

// ============================================
// 🔘 브리핑 메시지의 버튼·선택 메뉴 세션
// component ID에는 무작위 세션 ID와 보기 이름만 넣는다 (PUUID·API 키 없음).
// 타이머 없이 조회 시 만료를 지우고, 개수를 제한한다.
// ============================================

const SESSION_CONFIG = Object.freeze({
  ttlMs: 15 * 60 * 1000,
  maxSessions: 100,
  prefix: 'lolbrief',
});

const VIEWS = Object.freeze(['home', 'lane', 'allies', 'enemies', 'comp']);

let now = () => Date.now();
const sessions = new Map();

function pruneExpired() {
  const current = now();
  for (const [id, s] of sessions) if (s.expiresAt <= current) sessions.delete(id);
}

function createSession({ ownerId, guildId, channelId, model }) {
  pruneExpired();
  while (sessions.size >= SESSION_CONFIG.maxSessions) sessions.delete(sessions.keys().next().value);
  const session = {
    id: crypto.randomBytes(6).toString('hex'),
    ownerId,
    guildId: guildId || null,
    channelId: channelId || null,
    messageId: null,
    model,
    view: 'home',
    roleOverride: null,
    explanation: null,
    expiresAt: now() + SESSION_CONFIG.ttlMs,
  };
  sessions.set(session.id, session);
  return session;
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function viewCustomId(sessionId, view) {
  return `${SESSION_CONFIG.prefix}:${sessionId}:view:${view}`;
}

function roleCustomId(sessionId) {
  return `${SESSION_CONFIG.prefix}:${sessionId}:role`;
}

function isBriefingComponent(customId) {
  return typeof customId === 'string' && customId.startsWith(`${SESSION_CONFIG.prefix}:`);
}

/** 형식이 맞지 않으면 null */
function parseComponentId(customId) {
  if (!isBriefingComponent(customId)) return null;
  const parts = customId.split(':');
  if (!/^[0-9a-f]{12}$/.test(parts[1] || '')) return null;
  if (parts[2] === 'view' && parts.length === 4 && VIEWS.includes(parts[3])) {
    return { sessionId: parts[1], action: 'view', view: parts[3] };
  }
  if (parts[2] === 'role' && parts.length === 3) return { sessionId: parts[1], action: 'role' };
  return null;
}

/**
 * 세션 조작 권한 확인. 문제가 있으면 사용자에게 보여줄 문구, 없으면 null
 */
function checkAccess(session, { userId, guildId, messageId }) {
  if (session.ownerId !== userId) return '조회한 사람만 이 화면을 바꿀 수 있습니다.';
  if ((session.guildId || null) !== (guildId || null)) return '이 서버의 브리핑이 아닙니다.';
  if (session.messageId && messageId && session.messageId !== messageId) return '이 메시지의 브리핑 세션이 아닙니다.';
  return null;
}

module.exports = {
  SESSION_CONFIG,
  VIEWS,
  createSession,
  getSession,
  viewCustomId,
  roleCustomId,
  isBriefingComponent,
  parseComponentId,
  checkAccess,
  __testing: {
    setNow(fn) {
      now = fn;
    },
    reset() {
      now = () => Date.now();
      sessions.clear();
    },
    sessions,
  },
};
