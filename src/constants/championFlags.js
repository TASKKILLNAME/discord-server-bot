// CS가 구조적으로 낮은 챔피언 (로밍/다이브형)
// kda_offset: 이 챔피언은 KDA가 낮게 나오는 게 정상
// cs_offset: 이 챔피언은 CS가 낮게 나오는 게 정상
// is_roam: CS 지적 금지
// is_dive: KDA 지적 금지
//
// 참고: 정글/서포터의 CS 차이는 ROLE_CS_MODIFIER로 처리됨
// 여기서는 같은 역할 내에서의 챔피언별 추가 보정만 적용

module.exports = {
  CHAMPION_FLAGS: {
    // === 미드 어쌔신/다이브 ===
    Yasuo:    { cs_offset: -0.3, kda_offset: -0.8, is_dive: true },
    Yone:     { cs_offset: -0.2, kda_offset: -0.5, is_dive: true },
    Zed:      { cs_offset: -0.1, kda_offset: -0.4, is_dive: true },
    Talon:    { cs_offset: -0.3, kda_offset: -0.3, is_roam: true },
    Qiyana:   { cs_offset: -0.2, kda_offset: -0.3, is_roam: true },
    Katarina: { cs_offset: -0.4, kda_offset: -0.2, is_dive: true },
    Fizz:     { cs_offset: -0.2, kda_offset: -0.3, is_dive: true },
    Ekko:     { cs_offset: -0.1, kda_offset: -0.2, is_dive: true },
    Akali:    { cs_offset: -0.2, kda_offset: -0.4, is_roam: true, is_dive: true },
    Ahri:     { cs_offset: 0, kda_offset: 0, is_roam: true },

    // === 탑 다이브/브루저 ===
    Irelia:   { cs_offset: -0.1, kda_offset: -0.6, is_dive: true },
    Riven:    { cs_offset: -0.1, kda_offset: -0.5, is_dive: true },
    Camille:  { cs_offset: 0, kda_offset: -0.3, is_dive: true },
    Fiora:    { cs_offset: 0, kda_offset: -0.3, is_dive: true },
    Jax:      { cs_offset: 0, kda_offset: -0.3, is_dive: true },
    Renekton: { cs_offset: 0, kda_offset: -0.3, is_dive: true },
    Aatrox:   { cs_offset: 0, kda_offset: -0.4, is_dive: true },
    Ambessa:  { cs_offset: 0, kda_offset: -0.3, is_dive: true },

    // === 정글 다이브 ===
    LeeSin:   { cs_offset: 0, kda_offset: -0.2, is_dive: true },
    XinZhao:  { cs_offset: 0, kda_offset: -0.3, is_dive: true },
    Elise:    { cs_offset: 0, kda_offset: -0.2, is_dive: true },
    RekSai:   { cs_offset: 0, kda_offset: -0.3, is_dive: true },
    Nidalee:  { cs_offset: 0, kda_offset: -0.2, is_dive: true },
    KhaZix:   { cs_offset: 0, kda_offset: -0.3, is_dive: true },
    Rengar:   { cs_offset: 0, kda_offset: -0.4, is_dive: true },
    Vi:       { cs_offset: 0, kda_offset: -0.2, is_dive: true },
    Viego:    { cs_offset: 0, kda_offset: -0.3, is_dive: true },
    BelVeth:  { cs_offset: 0, kda_offset: -0.2, is_dive: true },

    // === 정글 탱커 (KDA 보정 없음) ===
    Poppy:    { cs_offset: 0, kda_offset: 0 },
    Sejuani:  { cs_offset: 0, kda_offset: 0 },
    Amumu:    { cs_offset: 0, kda_offset: 0 },
    Rammus:   { cs_offset: 0, kda_offset: 0 },
    Zac:      { cs_offset: 0, kda_offset: 0 },
    Maokai:   { cs_offset: 0, kda_offset: 0 },

    // === 정글 로밍 ===
    Nunu:     { cs_offset: 0, kda_offset: 0, is_roam: true },
    Ivern:    { cs_offset: -1.0, kda_offset: 0, is_roam: true },
  },
};
