module.exports = {
  TIER_EXPECTATIONS: {
    iron:        { cs_per_min: 4.5, vision_score: 12, kda: 1.2 },
    bronze:      { cs_per_min: 5.5, vision_score: 15, kda: 1.5 },
    silver:      { cs_per_min: 6.5, vision_score: 18, kda: 1.8 },
    gold:        { cs_per_min: 7.2, vision_score: 21, kda: 2.1 },
    platinum:    { cs_per_min: 7.8, vision_score: 24, kda: 2.3 },
    emerald:     { cs_per_min: 8.2, vision_score: 26, kda: 2.5 },
    diamond:     { cs_per_min: 8.6, vision_score: 28, kda: 2.7 },
    master:      { cs_per_min: 9.0, vision_score: 30, kda: 3.0 },
    grandmaster: { cs_per_min: 9.2, vision_score: 32, kda: 3.2 },
    challenger:  { cs_per_min: 9.5, vision_score: 35, kda: 3.5 },
  },
  // 역할별 CS/분 보정값 (라이너 기준 대비 차이)
  ROLE_CS_MODIFIER: {
    JUNGLE:  -3.0,  // 정글러는 라이너보다 CS/분이 ~3 낮음
    UTILITY: -4.0,  // 서포터는 CS를 거의 안 먹음
    TOP:      0,
    MIDDLE:   0,
    BOTTOM:   0,
  },
};
