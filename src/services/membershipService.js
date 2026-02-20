const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../../data/membership.json');

// ============================================
// 💰 멤버십 티어 정의
// ============================================
const TIERS = {
  bronze: { name: '🥉 브론즈', price: '1,000원', credits: 8, emoji: '🥉' },
  silver: { name: '🥈 실버', price: '5,000원', credits: 40, emoji: '🥈' },
  gold: { name: '🥇 골드', price: '10,000원', credits: 83, emoji: '🥇' },
};

// ============================================
// 📁 데이터 관리
// ============================================
function loadMembershipData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('멤버십 데이터 로드 오류:', err);
  }
  return {};
}

function saveMembershipData(data) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('멤버십 데이터 저장 오류:', err);
  }
}

// ============================================
// 💳 크레딧 조회
// ============================================
function getCredits(guildId, userId) {
  const data = loadMembershipData();
  return data[guildId]?.[userId]?.credits || 0;
}

function getMembershipInfo(guildId, userId) {
  const data = loadMembershipData();
  return data[guildId]?.[userId] || null;
}

// ============================================
// ✅ 크레딧 보유 확인 (차감 없이 체크만)
// ============================================
function hasCredit(guildId, userId) {
  const data = loadMembershipData();
  return (data[guildId]?.[userId]?.credits || 0) > 0;
}

// ============================================
// 🔻 크레딧 사용 (1회 차감)
// ============================================
function useCredit(guildId, userId, action) {
  const data = loadMembershipData();

  if (!data[guildId]?.[userId] || data[guildId][userId].credits <= 0) {
    return false; // 크레딧 부족
  }

  data[guildId][userId].credits -= 1;

  // history 최근 50개만 유지 (용량 관리)
  if (!data[guildId][userId].history) {
    data[guildId][userId].history = [];
  }
  data[guildId][userId].history.push({
    type: 'use',
    amount: -1,
    action,
    at: new Date().toISOString(),
  });
  if (data[guildId][userId].history.length > 50) {
    data[guildId][userId].history = data[guildId][userId].history.slice(-50);
  }

  saveMembershipData(data);
  return true;
}

// ============================================
// ➕ 크레딧 충전
// ============================================
function chargeCredits(guildId, userId, amount, tier, adminId) {
  const data = loadMembershipData();

  if (!data[guildId]) data[guildId] = {};
  if (!data[guildId][userId]) {
    data[guildId][userId] = {
      credits: 0,
      totalPurchased: 0,
      tier: null,
      history: [],
    };
  }

  data[guildId][userId].credits += amount;
  data[guildId][userId].totalPurchased += amount;
  data[guildId][userId].tier = tier;

  data[guildId][userId].history.push({
    type: 'charge',
    amount,
    tier,
    by: adminId,
    at: new Date().toISOString(),
  });

  // history 최근 50개만 유지
  if (data[guildId][userId].history.length > 50) {
    data[guildId][userId].history = data[guildId][userId].history.slice(-50);
  }

  saveMembershipData(data);
  return data[guildId][userId];
}

// ============================================
// 🌐 웹 대시보드용 함수
// ============================================

/**
 * 모든 서버의 멤버십 데이터 반환 (봇 오너 전용)
 */
function getAllMembershipData() {
  return loadMembershipData();
}

/**
 * 특정 서버의 멤버십 데이터 반환
 */
function getGuildMembershipData(guildId) {
  const data = loadMembershipData();
  return data[guildId] || {};
}

/**
 * 전체 통계 반환
 */
function getMembershipStats() {
  const data = loadMembershipData();
  let totalUsers = 0;
  let totalCreditsRemaining = 0;
  let totalPurchased = 0;
  let totalUsed = 0;
  const serverStats = {};

  for (const [guildId, users] of Object.entries(data)) {
    const guildUsers = Object.entries(users);
    let guildCredits = 0;
    let guildPurchased = 0;
    let guildUsed = 0;

    for (const [userId, info] of guildUsers) {
      totalUsers++;
      totalCreditsRemaining += info.credits || 0;
      totalPurchased += info.totalPurchased || 0;
      guildCredits += info.credits || 0;
      guildPurchased += info.totalPurchased || 0;

      const useCount = (info.history || []).filter((h) => h.type === 'use').length;
      totalUsed += useCount;
      guildUsed += useCount;
    }

    serverStats[guildId] = {
      users: guildUsers.length,
      creditsRemaining: guildCredits,
      totalPurchased: guildPurchased,
      totalUsed: guildUsed,
    };
  }

  return {
    totalUsers,
    totalCreditsRemaining,
    totalPurchased,
    totalUsed,
    serverStats,
  };
}

module.exports = {
  TIERS,
  loadMembershipData,
  saveMembershipData,
  getCredits,
  getMembershipInfo,
  hasCredit,
  useCredit,
  chargeCredits,
  getAllMembershipData,
  getGuildMembershipData,
  getMembershipStats,
};
