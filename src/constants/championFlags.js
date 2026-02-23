// CS가 구조적으로 낮은 챔피언 (로밍/다이브형)
// kda_offset: 이 챔피언은 KDA가 낮게 나오는 게 정상
// cs_offset: 이 챔피언은 CS가 낮게 나오는 게 정상
// is_roam: CS 지적 금지
// is_dive: KDA 지적 금지

module.exports = {
  CHAMPION_FLAGS: {
    Yasuo:    { cs_offset: -0.3, kda_offset: -0.8, is_dive: true },
    Yone:     { cs_offset: -0.2, kda_offset: -0.5, is_dive: true },
    Zed:      { cs_offset: -0.1, kda_offset: -0.4, is_dive: true },
    Talon:    { cs_offset: -0.3, kda_offset: -0.3, is_roam: true },
    Qiyana:   { cs_offset: -0.2, kda_offset: -0.3, is_roam: true },
    Katarina: { cs_offset: -0.4, kda_offset: -0.2, is_dive: true },
    Fizz:     { cs_offset: -0.2, kda_offset: -0.3, is_dive: true },
    Ekko:     { cs_offset: -0.1, kda_offset: -0.2, is_dive: true },
    Irelia:   { cs_offset: -0.1, kda_offset: -0.6, is_dive: true },
    Riven:    { cs_offset: -0.1, kda_offset: -0.5, is_dive: true },
    Akali:    { cs_offset: -0.2, kda_offset: -0.4, is_roam: true, is_dive: true },
    Ahri:     { cs_offset: 0, kda_offset: 0, is_roam: true },
  },
};
