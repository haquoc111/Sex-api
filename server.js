// server.js
const express = require("express");
const axios   = require("axios");

const app  = express();
const PORT = process.env.PORT || 3000;

const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=62385f65eb49fcb34c72a7d6489ad91d";

// ─────────────────────────────────────────────
//  CACHE & HISTORY
// ─────────────────────────────────────────────
let CACHE = {
  phien:            "0",
  ket_qua:          "đang tải",
  xuc_xac:          "0-0-0",
  du_doan:          "đang phân tích",
  do_tin_cay:       "0%",
  cau_dang_chay:    "-",
  loai_cau:         "đang phân tích",
  hanh_dong:        "-",
  canh_bao:         "đang tải",
  ty_le_tai:        "0%",
  ty_le_xiu:        "0%",
  ket_qua_gan_nhat: null,
  do_chinh_xac:     "chưa có",
  thuat_toan:       {},
  cap_nhat:         ""
};

// Mỗi entry: { phien_du_doan, phien_thuc_hien, du_doan, loai_cau,
//              hanh_dong, do_tin_cay, thuc_te, dung, checked, timestamp }
let HISTORY = [];

// Thống kê độ chính xác theo loại cầu
let STATS_BY_CAU = {};

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function toArr(data) {
  return data.map(i => (i.ket_qua === "tài" ? "T" : "X"));
}

function buildCauString(data, len = 15) {
  return toArr(data.slice(0, len)).join("");
}

function getStreak(data) {
  if (!data.length) return { side: "tài", count: 0 };
  const first = data[0].ket_qua;
  let count = 1;
  for (let i = 1; i < data.length; i++) {
    if (data[i].ket_qua === first) count++;
    else break;
  }
  return { side: first, count };
}

function stats(data, n) {
  const s = data.slice(0, n);
  let tai = 0, xiu = 0;
  s.forEach(i => (i.ket_qua === "tài" ? tai++ : xiu++));
  return { tai, xiu, total: s.length };
}

// ─────────────────────────────────────────────
//  NHẬN DIỆN CẦU (nhận sớm từ 3-4 phiên)
// ─────────────────────────────────────────────
function analyzePattern(data) {
  if (data.length < 3) {
    return { type: "chưa đủ dữ liệu", breakSignal: false, breakDirection: null, breakProb: "0%", score: 0 };
  }

  const arr    = toArr(data.slice(0, 30));
  const streak = getStreak(data);

  // ── 1. CẦU BỆT (nhận từ 3 phiên) ─────────────
  if (streak.count >= 3) {
    const breakProb = calcBreakProbForStreak(data, streak.side, streak.count);
    const shouldBreak = breakProb >= 0.55;
    return {
      type:           `bệt ${streak.side}`,
      streak:         streak.count,
      breakSignal:    shouldBreak,
      breakDirection: streak.side === "tài" ? "xỉu" : "tài",
      breakProb:      (breakProb * 100).toFixed(0) + "%",
      score:          80 + Math.min(10, streak.count)
    };
  }

  // ── 2. CẦU 1-1 (nhận từ 4 phiên xen kẽ) ─────
  {
    let alt = true;
    const check = Math.min(8, arr.length - 1);
    for (let i = 1; i <= check; i++) {
      if (arr[i] === arr[i - 1]) { alt = false; break; }
    }
    if (alt && arr.length >= 4) {
      const len11 = count1_1Length(arr);
      const breakProb = len11 >= 6 ? 0.70 : len11 >= 4 ? 0.45 : 0.30;
      return {
        type:           "1-1",
        streak:         len11,
        breakSignal:    breakProb >= 0.55,
        breakDirection: arr[0] === "T" ? "xỉu" : "tài",
        breakProb:      (breakProb * 100).toFixed(0) + "%",
        score:          85
      };
    }
  }

  // ── 3. CẦU 2-2 (nhận từ 2 cặp = 4 phiên) ────
  {
    const r = detect2_2(arr);
    if (r.found) {
      const shouldBreak = r.pairs >= 5;
      return {
        type:           "2-2",
        streak:         r.pairs,
        breakSignal:    shouldBreak,
        breakDirection: arr[0] === "T" ? "xỉu" : "tài",
        breakProb:      shouldBreak ? "60%" : "35%",
        score:          78
      };
    }
  }

  // ── 4. CẦU 3-3 (nhận từ 2 khối = 6 phiên) ───
  {
    const r = detect3_3(arr);
    if (r.found) {
      const shouldBreak = r.blocks >= 3;
      return {
        type:           "3-3",
        streak:         r.blocks,
        breakSignal:    shouldBreak,
        breakDirection: arr[0] === "T" ? "xỉu" : "tài",
        breakProb:      shouldBreak ? "62%" : "35%",
        score:          85
      };
    }
  }

  // ── 5. CẦU 2-1 / 1-2 (nhận từ 2 chu kỳ = 6p) ─
  {
    const r1 = detectNM(arr, 2, 1);
    if (r1.found) {
      return {
        type:           "2-1",
        streak:         r1.cycles,
        breakSignal:    r1.cycles >= 4,
        breakDirection: arr[0] === "T" ? "xỉu" : "tài",
        breakProb:      r1.cycles >= 4 ? "58%" : "30%",
        score:          75
      };
    }
    const r2 = detectNM(arr, 1, 2);
    if (r2.found) {
      return {
        type:           "1-2",
        streak:         r2.cycles,
        breakSignal:    r2.cycles >= 4,
        breakDirection: arr[0] === "T" ? "xỉu" : "tài",
        breakProb:      r2.cycles >= 4 ? "58%" : "30%",
        score:          75
      };
    }
  }

  // ── 6. CẦU 3-1 / 1-3 ─────────────────────────
  {
    const r1 = detectNM(arr, 3, 1);
    if (r1.found) {
      return {
        type:           "3-1",
        streak:         r1.cycles,
        breakSignal:    r1.cycles >= 3,
        breakDirection: arr[0] === "T" ? "xỉu" : "tài",
        breakProb:      "50%",
        score:          72
      };
    }
    const r2 = detectNM(arr, 1, 3);
    if (r2.found) {
      return {
        type:           "1-3",
        streak:         r2.cycles,
        breakSignal:    r2.cycles >= 3,
        breakDirection: arr[0] === "T" ? "xỉu" : "tài",
        breakProb:      "50%",
        score:          72
      };
    }
  }

  // ── 7. NGHIÊNG (mất cân bằng rõ trong 10 phiên) ─
  {
    const s10 = stats(data, 10);
    const rt  = s10.tai  / s10.total;
    const rx  = s10.xiu  / s10.total;
    if (rt >= 0.70 || rx >= 0.70) {
      const dom = rt >= 0.70 ? "tài" : "xỉu";
      return {
        type:           `nghiêng ${dom}`,
        streak:         s10.total,
        breakSignal:    true,
        breakDirection: dom === "tài" ? "xỉu" : "tài",
        breakProb:      "70%",
        score:          70
      };
    }
  }

  return { type: "không rõ", breakSignal: false, breakDirection: null, breakProb: "0%", score: 50 };
}

// ─── Sub-detectors ──────────────────────────

function count1_1Length(arr) {
  let len = 1;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] !== arr[i - 1]) len++;
    else break;
  }
  return len;
}

function detect2_2(arr) {
  if (arr.length < 4) return { found: false, pairs: 0 };
  let pairs = 0;
  let i = 0;
  while (i + 1 < arr.length) {
    if (arr[i] === arr[i + 1]) {
      if (pairs === 0 || arr[i] !== arr[i - 2]) { pairs++; i += 2; }
      else break;
    } else break;
  }
  return { found: pairs >= 2, pairs };
}

function detect3_3(arr) {
  if (arr.length < 6) return { found: false, blocks: 0 };
  let blocks = 0;
  let i      = 0;
  let expect = arr[0];
  while (i + 3 <= arr.length) {
    if (arr[i] === expect && arr[i+1] === expect && arr[i+2] === expect) {
      blocks++;
      expect = expect === "T" ? "X" : "T";
      i += 3;
    } else break;
  }
  return { found: blocks >= 2, blocks };
}

function detectNM(arr, n, m) {
  const period = n + m;
  if (arr.length < period * 2) return { found: false, cycles: 0 };
  const unit  = arr[0];
  const other = unit === "T" ? "X" : "T";
  let cycles  = 0;
  let i       = 0;
  while (i + period <= arr.length) {
    let ok = true;
    for (let j = 0; j < n && ok; j++)        if (arr[i+j] !== unit)  ok = false;
    for (let j = n; j < period && ok; j++)   if (arr[i+j] !== other) ok = false;
    if (!ok) break;
    cycles++;
    i += period;
  }
  return { found: cycles >= 2, cycles };
}

// Xác suất bẻ cầu bệt dựa trên lịch sử thực tế
function calcBreakProbForStreak(data, side, currentCount) {
  const arr = toArr(data);
  const val = side === "tài" ? "T" : "X";
  const opp = val  === "T"  ? "X" : "T";
  let total = 0, broke = 0;

  for (let i = 0; i + currentCount < arr.length; i++) {
    let streakHere = 0;
    for (let j = i; j < arr.length && arr[j] === val; j++) streakHere++;
    if (streakHere === currentCount) {
      total++;
      if (arr[i + currentCount] === opp) broke++;
    }
  }

  if (total < 2) {
    if (currentCount >= 7) return 0.75;
    if (currentCount >= 5) return 0.60;
    if (currentCount >= 4) return 0.50;
    return 0.40;
  }
  return broke / total;
}

// ─────────────────────────────────────────────
//  QUYẾT ĐỊNH THEO / BẺ
// ─────────────────────────────────────────────
function decideCau(pat, data) {
  const { type, breakSignal, breakDirection } = pat;
  const streak = getStreak(data);
  const cur    = data[0].ket_qua;
  const inv    = cur === "tài" ? "xỉu" : "tài";

  if (type.startsWith("bệt")) {
    if (breakSignal) {
      return { du_doan: breakDirection, hanh_dong: "BẺ",
        canh_bao: `🔴 BẺ CẦU BỆT (${streak.count} phiên, bẻ ${pat.breakProb}) → ${breakDirection.toUpperCase()}`, conf: 88 };
    }
    const side = type.includes("tài") ? "tài" : "xỉu";
    return { du_doan: side, hanh_dong: "THEO",
      canh_bao: `🟢 THEO BỆT ${side.toUpperCase()} (${streak.count} phiên)`, conf: 80 };
  }

  if (type === "1-1") {
    if (breakSignal) {
      return { du_doan: cur, hanh_dong: "BẺ",
        canh_bao: `🔴 BẺ CẦU 1-1 (${pat.streak} phiên) → ${cur.toUpperCase()}`, conf: 82 };
    }
    return { du_doan: inv, hanh_dong: "THEO",
      canh_bao: `🟢 THEO 1-1 → ${inv.toUpperCase()}`, conf: 85 };
  }

  if (type === "2-2") {
    if (breakSignal) {
      const brk = cur === "tài" ? "xỉu" : "tài";
      return { du_doan: brk, hanh_dong: "BẺ",
        canh_bao: `🔴 BẺ CẦU 2-2 (${pat.streak} cặp) → ${brk.toUpperCase()}`, conf: 83 };
    }
    const last2 = data.slice(0, 2).map(i => i.ket_qua);
    const next  = last2[0] === last2[1] ? inv : cur;
    return { du_doan: next, hanh_dong: "THEO",
      canh_bao: `🟢 THEO 2-2 → ${next.toUpperCase()}`, conf: 78 };
  }

  if (type === "3-3") {
    if (breakSignal) {
      return { du_doan: breakDirection, hanh_dong: "BẺ",
        canh_bao: `🔴 BẺ CẦU 3-3 (${pat.streak} khối) → ${breakDirection.toUpperCase()}`, conf: 87 };
    }
    const next = streak.count >= 3 ? (streak.side === "tài" ? "xỉu" : "tài") : streak.side;
    return { du_doan: next, hanh_dong: "THEO",
      canh_bao: `🟢 THEO 3-3 → ${next.toUpperCase()}`, conf: 85 };
  }

  if (type === "2-1" || type === "1-2" || type === "3-1" || type === "1-3") {
    if (breakSignal) {
      return { du_doan: breakDirection, hanh_dong: "BẺ",
        canh_bao: `🔴 BẺ ${type.toUpperCase()} (${pat.streak} chu kỳ) → ${breakDirection.toUpperCase()}`, conf: 80 };
    }
    return { du_doan: inv, hanh_dong: "THEO",
      canh_bao: `🟢 THEO ${type.toUpperCase()} → ${inv.toUpperCase()}`, conf: 75 };
  }

  if (type.startsWith("nghiêng")) {
    const s = stats(data, 10);
    const dom = s.tai > s.xiu ? "tài" : "xỉu";
    const brk = dom === "tài" ? "xỉu" : "tài";
    const pct = Math.round(Math.max(s.tai, s.xiu) / s.total * 100);
    return { du_doan: brk, hanh_dong: "BẺ",
      canh_bao: `🔴 MẤT CÂN BẰNG ${dom.toUpperCase()} ${pct}% → BẺ ${brk.toUpperCase()}`, conf: 78 };
  }

  // Không rõ
  const s15 = stats(data, 15);
  if (s15.tai > s15.xiu + 3)
    return { du_doan: "xỉu", hanh_dong: "BẺ", canh_bao: "📊 Đảo xu hướng (lệch Tài)", conf: 62 };
  if (s15.xiu > s15.tai + 3)
    return { du_doan: "tài",  hanh_dong: "BẺ", canh_bao: "📊 Đảo xu hướng (lệch Xỉu)", conf: 62 };
  return { du_doan: inv, hanh_dong: "THEO", canh_bao: "📊 Cân bằng, đảo chiều", conf: 55 };
}

// ─────────────────────────────────────────────
//  THUẬT TOÁN AI
// ─────────────────────────────────────────────
function markovPredict(data, order) {
  if (order === undefined) order = 2;
  if (data.length < order + 5) return { du_doan: null, confidence: 0 };
  const arr   = toArr(data);
  const trans = {};
  for (let i = 0; i < arr.length - order; i++) {
    const st = arr.slice(i, i + order).join("");
    const nx = arr[i + order];
    if (!trans[st]) trans[st] = { T: 0, X: 0 };
    trans[st][nx]++;
  }
  const cur = arr.slice(0, order).join("");
  const t   = trans[cur];
  if (!t || t.T + t.X < 3) return order > 1 ? markovPredict(data, order - 1) : { du_doan: null, confidence: 0 };
  const total = t.T + t.X;
  const pT = t.T / total, pX = t.X / total;
  return { du_doan: pT >= pX ? "tài" : "xỉu", confidence: Math.round(Math.max(pT, pX) * 100), samples: total };
}

function weightedPredict(data, win) {
  if (win === undefined) win = 30;
  if (data.length < 5) return { du_doan: null, confidence: 0 };
  let sT = 0, sX = 0;
  data.slice(0, win).forEach((item, idx) => {
    const w = Math.exp(-idx * 0.09);
    item.ket_qua === "tài" ? sT += w : sX += w;
  });
  const tot = sT + sX, pT = sT / tot, pX = sX / tot;
  if (pT > 0.62) return { du_doan: "xỉu", confidence: Math.round(pT * 100) };
  if (pX > 0.62) return { du_doan: "tài",  confidence: Math.round(pX * 100) };
  return { du_doan: data[0].ket_qua, confidence: 55 };
}

function patternMatchPredict(data, pLen) {
  if (pLen === undefined) pLen = 4;
  if (data.length < pLen + 8) return { du_doan: null, confidence: 0 };
  const arr = toArr(data);
  const cur = arr.slice(0, pLen).join("");
  let mT = 0, mX = 0;
  for (let i = pLen; i < arr.length - 1; i++) {
    if (arr.slice(i - pLen, i).join("") === cur) arr[i] === "T" ? mT++ : mX++;
  }
  const total = mT + mX;
  if (total < 2) return pLen > 2 ? patternMatchPredict(data, pLen - 1) : { du_doan: null, confidence: 0 };
  const pT = mT / total, pX = mX / total;
  return { du_doan: pT >= pX ? "tài" : "xỉu", confidence: Math.round(Math.max(pT, pX) * 100), matches: total };
}

function diceScorePredict(data, win) {
  if (win === undefined) win = 15;
  if (data.length < win) return { du_doan: null, confidence: 0 };
  const totals    = data.slice(0, win).map(i => i.total);
  const avgRecent = (totals[0] + totals[1] + totals[2]) / 3;
  const avgAll    = totals.reduce((a, b) => a + b, 0) / totals.length;
  const hiC = totals.filter(t => t >= 11).length;
  const loC = totals.filter(t => t <= 10).length;
  if (avgRecent > 11.5 && avgRecent > avgAll + 1.5) return { du_doan: "xỉu", confidence: 68 };
  if (avgRecent < 9.5  && avgRecent < avgAll - 1.5) return { du_doan: "tài",  confidence: 68 };
  if (hiC > loC * 1.5) return { du_doan: "xỉu", confidence: 63 };
  if (loC > hiC * 1.5) return { du_doan: "tài",  confidence: 63 };
  return { du_doan: data[0].ket_qua === "tài" ? "xỉu" : "tài", confidence: 54 };
}

function ensemblePredict(data) {
  const mk = markovPredict(data, 2);
  const wt = weightedPredict(data, 30);
  const pm = patternMatchPredict(data, 4);
  const dc = diceScorePredict(data, 15);
  const W  = [{ r: mk, w: 0.35 }, { r: wt, w: 0.25 }, { r: pm, w: 0.25 }, { r: dc, w: 0.15 }];
  let sT = 0, sX = 0, tw = 0;
  W.forEach(({ r, w }) => {
    if (!r.du_doan) return;
    const ew = w * (r.confidence / 100);
    r.du_doan === "tài" ? sT += ew : sX += ew;
    tw += ew;
  });
  if (!tw) return null;
  const pT = sT / tw, pX = sX / tw;
  return {
    du_doan:    pT >= pX ? "tài" : "xỉu",
    confidence: Math.min(92, Math.max(52, Math.round(Math.max(pT, pX) * 100))),
    vote_tai:   (pT * 100).toFixed(1) + "%",
    vote_xiu:   (pX * 100).toFixed(1) + "%",
    details:    { markov: mk, weighted: wt, pattern: pm, dice: dc }
  };
}

// ─────────────────────────────────────────────
//  TỔNG HỢP DỰ ĐOÁN
// ─────────────────────────────────────────────
function predict(data) {
  if (!data.length) return {
    du_doan: "tài", do_tin_cay: "50%", loai_cau: "chưa có dữ liệu",
    hanh_dong: "-", canh_bao: "chưa có dữ liệu",
    ty_le_tai: "0%", ty_le_xiu: "0%", thuat_toan: {}
  };

  const pattern  = analyzePattern(data);
  const cau      = decideCau(pattern, data);
  const ensemble = ensemblePredict(data);

  let final_du_doan, final_conf, final_canh_bao, final_hanh_dong;

  if (!ensemble) {
    final_du_doan   = cau.du_doan;
    final_conf      = cau.conf;
    final_canh_bao  = cau.canh_bao;
    final_hanh_dong = cau.hanh_dong;
  } else if (cau.du_doan === ensemble.du_doan) {
    final_du_doan   = cau.du_doan;
    final_conf      = Math.min(93, Math.round((cau.conf * 0.45 + ensemble.confidence * 0.55) * 1.04));
    final_canh_bao  = cau.canh_bao + " ✅AI";
    final_hanh_dong = cau.hanh_dong;
  } else {
    // Trái chiều: ưu tiên cầu, ghi chú AI ngược
    final_du_doan   = cau.du_doan;
    final_conf      = Math.min(72, Math.round(cau.conf * 0.88));
    final_canh_bao  = cau.canh_bao + " ⚠️AI=" + ensemble.du_doan.toUpperCase();
    final_hanh_dong = cau.hanh_dong;
  }

  const s10 = stats(data, 10);
  return {
    du_doan:    final_du_doan,
    do_tin_cay: Math.min(93, Math.max(52, final_conf)) + "%",
    loai_cau:   pattern.type,
    hanh_dong:  final_hanh_dong,
    canh_bao:   final_canh_bao,
    ty_le_tai:  ((s10.tai / s10.total) * 100).toFixed(0) + "%",
    ty_le_xiu:  ((s10.xiu / s10.total) * 100).toFixed(0) + "%",
    thuat_toan: ensemble ? {
      markov:   { du_doan: ensemble.details.markov.du_doan,   confidence: ensemble.details.markov.confidence   },
      weighted: { du_doan: ensemble.details.weighted.du_doan, confidence: ensemble.details.weighted.confidence },
      pattern:  { du_doan: ensemble.details.pattern.du_doan,  confidence: ensemble.details.pattern.confidence  },
      dice:     { du_doan: ensemble.details.dice.du_doan,     confidence: ensemble.details.dice.confidence     },
      ensemble: { du_doan: ensemble.du_doan, confidence: ensemble.confidence, vote_tai: ensemble.vote_tai, vote_xiu: ensemble.vote_xiu },
      cau:      { du_doan: cau.du_doan, hanh_dong: cau.hanh_dong, loai: pattern.type, break_prob: pattern.breakProb }
    } : {}
  };
}

// ─────────────────────────────────────────────
//  VERIFY KẾT QUẢ ĐÚNG / SAI
// ─────────────────────────────────────────────
function verifyHistory(parsed) {
  const phienMap = {};
  parsed.forEach(p => { phienMap[p.phien] = p.ket_qua; });

  for (const h of HISTORY) {
    if (h.checked) continue;
    const actual = phienMap[h.phien_thuc_hien];
    if (actual === undefined) continue;
    h.checked = true;
    h.thuc_te = actual;
    h.dung    = h.du_doan === actual;
    const key = h.loai_cau || "không rõ";
    if (!STATS_BY_CAU[key]) STATS_BY_CAU[key] = { total: 0, correct: 0 };
    STATS_BY_CAU[key].total++;
    if (h.dung) STATS_BY_CAU[key].correct++;
  }
}

function calcAccuracy() {
  const done    = HISTORY.filter(h => h.checked);
  const correct = done.filter(h => h.dung).length;
  if (!done.length) return { ty_le: "chưa có", tong: 0, dung: 0, sai: 0 };
  return { ty_le: ((correct / done.length) * 100).toFixed(1) + "%", tong: done.length, dung: correct, sai: done.length - correct };
}

// ─────────────────────────────────────────────
//  UPDATE LOOP
// ─────────────────────────────────────────────
let lastPhien = null;

async function updateData() {
  try {
    const res  = await axios.get(API_URL, { timeout: 8000 });
    const json = res.data;
    let sessions = json.list || [];
    if (!Array.isArray(sessions) || !sessions.length) return;

    sessions.sort((a, b) => b.id - a.id);
    sessions = sessions.slice(0, 100);

    const parsed = sessions.map(item => {
      const d = item.dices || [1, 1, 1];
      const x1 = d[0] || 1, x2 = d[1] || 1, x3 = d[2] || 1;
      return { phien: item.id, ket_qua: item.resultTruyenThong === "TAI" ? "tài" : "xỉu", xuc_xac: `${x1}-${x2}-${x3}`, total: x1 + x2 + x3 };
    });

    verifyHistory(parsed);

    const prediction = predict(parsed);
    const acc        = calcAccuracy();
    const latestPhien = parsed[0].phien;

    // Kết quả gần nhất đã verify
    const lastVerified    = HISTORY.slice().reverse().find(h => h.checked);
    const ket_qua_gan_nhat = lastVerified ? {
      phien:   lastVerified.phien_thuc_hien,
      du_doan: lastVerified.du_doan,
      thuc_te: lastVerified.thuc_te,
      dung:    lastVerified.dung,
      icon:    lastVerified.dung ? "✅" : "❌"
    } : null;

    // Lưu dự đoán mới (chỉ khi phiên mới)
    if (latestPhien !== lastPhien) {
      lastPhien = latestPhien;
      HISTORY.push({
        phien_du_doan:   latestPhien,
        phien_thuc_hien: latestPhien + 1,
        du_doan:         prediction.du_doan,
        loai_cau:        prediction.loai_cau,
        hanh_dong:       prediction.hanh_dong,
        do_tin_cay:      prediction.do_tin_cay,
        timestamp:       new Date().toISOString(),
        checked:         false,
        thuc_te:         null,
        dung:            null
      });
      if (HISTORY.length > 100) HISTORY.shift();
    }

    CACHE = {
      phien:            latestPhien,
      ket_qua:          parsed[0].ket_qua,
      xuc_xac:          parsed[0].xuc_xac,
      du_doan:          prediction.du_doan,
      do_tin_cay:       prediction.do_tin_cay,
      cau_dang_chay:    buildCauString(parsed, 15),
      loai_cau:         prediction.loai_cau,
      hanh_dong:        prediction.hanh_dong,
      canh_bao:         prediction.canh_bao,
      ty_le_tai:        prediction.ty_le_tai,
      ty_le_xiu:        prediction.ty_le_xiu,
      ket_qua_gan_nhat: ket_qua_gan_nhat,
      do_chinh_xac:     acc.ty_le,
      acc_detail:       acc,
      thuat_toan:       prediction.thuat_toan,
      cap_nhat:         new Date().toLocaleTimeString("vi-VN")
    };

    console.log(
      `[${CACHE.cap_nhat}] #${latestPhien} KQ:${parsed[0].ket_qua.toUpperCase()} | ${prediction.loai_cau} | ${prediction.hanh_dong} → ${prediction.du_doan.toUpperCase()} ${prediction.do_tin_cay}` +
      (ket_qua_gan_nhat ? ` | ${ket_qua_gan_nhat.icon} phiên ${ket_qua_gan_nhat.phien}: đoán ${ket_qua_gan_nhat.du_doan.toUpperCase()} thực ${ket_qua_gan_nhat.thuc_te.toUpperCase()}` : "")
    );
  } catch (err) {
    console.log("Lỗi API:", err.message);
  }
}

// ─────────────────────────────────────────────
//  ENDPOINTS
// ─────────────────────────────────────────────
app.get("/", (req, res) => res.json(CACHE));

app.get("/predict", (req, res) => res.json({ status: "success", data: CACHE }));

app.get("/algorithms", (req, res) => res.json({
  status: "success",
  thuat_toan: CACHE.thuat_toan,
  ghi_chu: {
    markov:   "Markov Chain bậc 2 — xác suất chuyển trạng thái",
    weighted: "Trọng số mũ — phiên gần ảnh hưởng nhiều hơn",
    pattern:  "Khớp mẫu 4 phiên cuối với lịch sử",
    dice:     "Xu hướng tổng điểm xúc xắc",
    ensemble: "Bỏ phiếu: markov×35% + weighted×25% + pattern×25% + dice×15%"
  }
}));

app.get("/accuracy", (req, res) => {
  const acc = calcAccuracy();
  res.json({
    status:       "success",
    ...acc,
    theo_loai_cau: Object.entries(STATS_BY_CAU).map(([loai, s]) => ({
      loai_cau: loai,
      total:    s.total,
      correct:  s.correct,
      sai:      s.total - s.correct,
      ty_le:    s.total > 0 ? ((s.correct / s.total) * 100).toFixed(1) + "%" : "n/a"
    })),
    lich_su: HISTORY.slice(-30).reverse().map(h => ({
      phien_du_doan:   h.phien_du_doan,
      phien_thuc_hien: h.phien_thuc_hien,
      du_doan:         h.du_doan,
      loai_cau:        h.loai_cau,
      hanh_dong:       h.hanh_dong,
      thuc_te:         h.thuc_te,
      ket_qua:         h.checked ? (h.dung ? "✅ ĐÚNG" : "❌ SAI") : "⏳ chờ",
      timestamp:       h.timestamp
    }))
  });
});

// ─────────────────────────────────────────────
//  KHỞI ĐỘNG
// ─────────────────────────────────────────────
updateData();
setInterval(updateData, 5000);

app.listen(PORT, () => {
  console.log(`\n🎲 Tài Xỉu Predict Server — port ${PORT}`);
  console.log("  /            → realtime cache");
  console.log("  /predict     → dự đoán đầy đủ");
  console.log("  /algorithms  → chi tiết thuật toán");
  console.log("  /accuracy    → lịch sử đúng/sai theo từng loại cầu\n");
});