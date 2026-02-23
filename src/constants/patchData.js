// 패치노트는 자동 파싱 없이 수동 관리
// 새 패치 나올 때마다 이 파일만 업데이트하면 됨
module.exports = {
  CURRENT_PATCH: '15.4',
  CHANGES: [
    { champion: 'Ahri', stat: 'Q피해량', change: '+10', impact: '버프', detail: '라인전 강화' },
    { champion: 'Yasuo', stat: '기본 방어력', change: '-3', impact: '너프', detail: '초반 생존력 감소' },
    { champion: 'Orianna', stat: 'W쿨타임', change: '-1초', impact: '버프', detail: '교전 빈도 증가' },
    // 패치마다 추가
  ],
};
