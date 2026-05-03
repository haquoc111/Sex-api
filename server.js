// server.js
const express = require("express");
const axios   = require("axios");

const app  = express();
const PORT = process.env.PORT || 3000;

const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=62385f65eb49fcb34c72a7d6489ad91d";

// ─────────────────────────────────────────────
//  GLOBAL STATE
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
  cap_nhat:         ""
};

let HISTORY = [];

let PREDICTOR_STATS = {
  markov:      { correct: 0, total: 0, recent10: { correct: 0, total: 0 } },
  cau:         { correct: 0, total: 0, recent10: { correct: 0, total: 0 } },
  dice:        { correct: 0, total: 0, recent10: { correct: 0, total: 0 } },
  oscillation: { correct: 0, total: 0, recent10: { correct: 0, total: 0 } },
  balance:     { correct: 0, total: 0, recent10: { correct: 0, total: 0 } }
};

let STREAK_BREAK_MEMORY = {};

// ─────────────────────────────────────────────
//  TIỆN ÍCH
// ─────────────────────────────────────────────
const toArr = (data) => data.map(i => (i.ket_qua === "tài" ? "T" : "X"));
const buildCauString = (data, len = 12) => toArr(data.slice(0, len)).join("");
const getStreak = (data) => {
  if (!data.length) return { side: "tài", count: 0 };
  const first = data[0].ket_qua;
  let count = 1;
  for (let i = 1; i < data.length; i++) {
    if (data[i].ket_qua === first) count++;
    else break;
  }
  return { side: first, count };
};

// ─────────────────────────────────────────────
//  1. DỰ ĐOÁN BẰNG MARKOV (bậc 3 khi đủ dữ liệu, nếu không thì bậc 2)
// ─────────────────────────────────────────────
function markovPredict(data, order = 3) {
  const arr = toArr(data);
  // Yêu cầu ít nhất order+2 mẫu để có đủ chuyển tiếp
  if (arr.length < order + 2) {
    if (order > 1) return markovPredict(data, order - 1);
    return { du_doan: null, confidence: 0 };
  }
  const trans = {};
  for (let i = 0; i < arr.length - order; i++) {
    const state = arr.slice(i, i + order).join("");
    const next  = arr[i + order];
    if (!trans[state]) trans[state] = { T: 0, X: 0 };
    trans[state][next]++;
  }
  const curState = arr.slice(0, order).join("");
  const counts   = trans[curState];
  if (!counts || counts.T + counts.X < 3) {
    if (order > 1) return markovPredict(data, order - 1);
    return { du_doan: null, confidence: 0 };
  }
  const total = counts.T + counts.X;
  const pT    = counts.T / total;
  const pX    = counts.X / total;
  return {
    du_doan:    pT >= pX ? "tài" : "xỉu",
    confidence: Math.round(Math.max(pT, pX) * 100),
    samples:    total
  };
}

// ─────────────────────────────────────────────
//  2. DỰ ĐOÁN DỰA TRÊN MẪU CẦU (nâng cấp)
// ─────────────────────────────────────────────
function patternPredict(data) {
  if (data.length < 3) return { du_doan: null, confidence: 0, loai_cau: "chưa đủ" };
  const arr    = toArr(data);
  const streak = getStreak(data);
  const cur    = data[0].ket_qua;
  const inv    = cur === "tài" ? "xỉu" : "tài";

  // ── Cầu bệt (streak >= 3) ──
  if (streak.count >= 3) {
    const key = streak.count;
    if (!STREAK_BREAK_MEMORY[key]) {
      const defaultBreakProb = Math.min(0.9, 0.35 + (key - 3) * 0.07);
      STREAK_BREAK_MEMORY[key] = { total: 0, broke: 0, defaultBreakProb };
    }
    const mem   = STREAK_BREAK_MEMORY[key];
    let breakProb = mem.defaultBreakProb;
    if (mem.total >= 4) {
      breakProb = mem.broke / mem.total;
    }
    const theo = streak.side;
    const be   = theo === "tài" ? "xỉu" : "tài";
    if (breakProb >= 0.50) {
      return { du_doan: be, confidence: Math.round(breakProb * 100), loai_cau: `bệt ${theo}`,
               hanh_dong: "BẺ", reason: `bệt ${key} phiên, tỉ lệ gãy ${mem.total>=4?Math.round(breakProb*100):'~'+Math.round(breakProb*100)}%` };
    }
    return { du_doan: theo, confidence: Math.round((1 - breakProb) * 100), loai_cau: `bệt ${theo}`,
             hanh_dong: "THEO", reason: `bệt ${key} phiên, khả năng tiếp tục cao` };
  }

  // ── Cầu 1-1 ──
  let alt = true;
  const check = Math.min(6, arr.length - 1);
  for (let i = 1; i <= check; i++) if (arr[i] === arr[i-1]) { alt = false; break; }
  if (alt && arr.length >= 4) {
    return { du_doan: inv, confidence: 72, loai_cau: "1-1", hanh_dong: "THEO",
             reason: "cầu 1-1 rõ" };
  }

  // ── Cầu 2-2 ──
  if (arr.length >= 4) {
    let pairs = 0, i = 0;
    const expect = arr[0];
    while (i+1 < arr.length) {
      if (arr[i] === arr[i+1] && arr[i] === (pairs%2===0?expect:(expect==='T'?'X':'T'))) {
        pairs++; i+=2;
      } else break;
    }
    if (pairs >= 2) {
      const nextSide = pairs % 2 === 0 ? expect : (expect === 'T' ? 'X' : 'T');
      return { du_doan: nextSide, confidence: 75, loai_cau: "2-2", hanh_dong: "THEO" };
    }
  }

  // ── Cầu 3-3 ──
  if (arr.length >= 6) {
    let blocks = 0, i = 0;
    let exp = arr[0];
    while (i+3 <= arr.length) {
      if (arr[i]===exp && arr[i+1]===exp && arr[i+2]===exp) {
        blocks++;
        exp = exp === 'T' ? 'X' : 'T';
        i += 3;
      } else break;
    }
    if (blocks >= 2) {
      const nextSide = blocks % 2 === 0 ? exp : (exp === 'T' ? 'X' : 'T');
      return { du_doan: nextSide, confidence: 78, loai_cau: "3-3", hanh_dong: "THEO" };
    }
  }

  // ── Cầu 4-4 (mới thêm) ──
  if (arr.length >= 8) {
    let blocks = 0, i = 0;
    let exp = arr[0];
    while (i+4 <= arr.length) {
      if (arr[i]===exp && arr[i+1]===exp && arr[i+2]===exp && arr[i+3]===exp) {
        blocks++;
        exp = exp === 'T' ? 'X' : 'T';
        i += 4;
      } else break;
    }
    if (blocks >= 2) {
      const nextSide = blocks % 2 === 0 ? exp : (exp === 'T' ? 'X' : 'T');
      return { du_doan: nextSide, confidence: 80, loai_cau: "4-4", hanh_dong: "THEO" };
    }
  }

  // ── Nghiêng >70% trong 10 phiên ──
  const s10 = data.slice(0,10);
  const tCnt = s10.filter(i=>i.ket_qua==='tài').length;
  const xCnt = s10.length - tCnt;
  if (tCnt >= 7 || xCnt >= 7) {
    const dom = tCnt >= 7 ? 'tài' : 'xỉu';
    const brk = dom === 'tài' ? 'xỉu' : 'tài';
    return { du_doan: brk, confidence: 62, loai_cau: `nghiêng ${dom}`, hanh_dong: "BẺ" };
  }

  return { du_doan: null, confidence: 0, loai_cau: "không rõ" };
}

// ─────────────────────────────────────────────
//  3. DỰ ĐOÁN THEO TỔNG ĐIỂM (sử dụng độ lệch chuẩn và trung bình)
// ─────────────────────────────────────────────
function dicePredict(data) {
  if (data.length < 10) return { du_doan: null, confidence: 0 };
  const totals = data.slice(0, 10).map(i => i.total);
  const avg = totals.reduce((a,b)=>a+b,0)/totals.length;
  const variance = totals.reduce((s, t) => s + (t - avg) ** 2, 0) / totals.length;
  const std = Math.sqrt(variance);

  // Nếu trung bình cao và độ lệch chuẩn thấp -> xu hướng tài rõ rệt, dự đoán xỉu (hồi quy)
  if (avg > 11.5 && std < 2.5) return { du_doan: "xỉu", confidence: 70 };
  if (avg < 9.5  && std < 2.5) return { du_doan: "tài", confidence: 70 };
  // Trung bình hơi cao/thấp với độ lệch chuẩn trung bình
  if (avg > 11.0) return { du_doan: "xỉu", confidence: 60 };
  if (avg < 10.0) return { du_doan: "tài", confidence: 60 };
  return { du_doan: null, confidence: 0 };
}

// ─────────────────────────────────────────────
//  4. DỰ ĐOÁN DAO ĐỘNG (oscillation) - mở rộng nhận diện các mẫu đảo chiều
// ─────────────────────────────────────────────
function oscillationPredict(data) {
  if (data.length < 5) return { du_doan: null, confidence: 0 };
  const arr = data.slice(0,5).map(i=>i.ket_qua);
  // Kiểm tra mẫu T X T X T => tiếp tục X
  if (arr[0]===arr[2] && arr[2]===arr[4] && arr[1]===arr[3] && arr[0]!==arr[1]) {
    return { du_doan: arr[1], confidence: 70 }; // dự đoán tiếp tục đảo
  }
  if (arr[0]===arr[2] && arr[1]===arr[3] && arr[0]!==arr[1]) {
    return { du_doan: arr[0], confidence: 65 }; // mẫu 2-1
  }
  // Nếu 5 phiên gần nhất có 3 T và 2 X, kiểm tra xem có luân phiên không
  const last4 = data.slice(0,4).map(i=>i.ket_qua);
  if (last4[0]===last4[2] && last4[1]===last4[3] && last4[0]!==last4[1]) {
    return { du_doan: last4[0], confidence: 65 };
  }
  return { du_doan: null, confidence: 0 };
}

// ─────────────────────────────────────────────
//  5. DỰ ĐOÁN CÂN BẰNG DÀI HẠN (balance) - mean reversion 30-50 phiên
// ─────────────────────────────────────────────
function balancePredict(data) {
  if (data.length < 30) return { du_doan: null, confidence: 0 };
  const sample = data.slice(0, 30);
  const tCount = sample.filter(i => i.ket_qua === 'tài').length;
  const ratio  = tCount / sample.length;
  if (ratio > 0.6) return { du_doan: "xỉu", confidence: Math.round((ratio - 0.5) * 200) }; // confidence 20-40
  if (ratio < 0.4) return { du_doan: "tài", confidence: Math.round((0.5 - ratio) * 200) };
  return { du_doan: null, confidence: 0 };
}

// ─────────────────────────────────────────────
//  TÍNH TRỌNG SỐ ĐỘNG (có xét phong độ 10 phiên gần nhất)
// ─────────────────────────────────────────────
function getPredictorWeights() {
  const stats = PREDICTOR_STATS;
  const defaultWeight = {
    markov: 0.25, cau: 0.35, dice: 0.15, oscillation: 0.15, balance: 0.10
  };

  const calcWeight = (stat) => {
    if (stat.total < 5) return null;
    const overall = stat.correct / stat.total;
    // Nếu recent10 có ít nhất 3 mẫu thì kết hợp 70% overall + 30% recent
    if (stat.recent10 && stat.recent10.total >= 3) {
      const recent = stat.recent10.correct / stat.recent10.total;
      return overall * 0.7 + recent * 0.3;
    }
    return overall;
  };

  const weights = {};
  for (let k of ['markov', 'cau', 'dice', 'oscillation', 'balance']) {
    const w = calcWeight(stats[k]);
    weights[k] = w !== null ? w : defaultWeight[k];
  }

  // Chuẩn hóa
  const total = Object.values(weights).reduce((a,b)=>a+b,0);
  for (let k in weights) weights[k] /= total;

  return weights;
}

// ─────────────────────────────────────────────
//  ENSEMBLE NÂNG CAO (có cơ chế đồng thuận và ngưỡng confidence)
// ─────────────────────────────────────────────
function finalPredict(data) {
  const mk = markovPredict(data);
  const pt = patternPredict(data);
  const dc = dicePredict(data);
  const os = oscillationPredict(data);
  const bl = balancePredict(data);

  const preds = [
    { source: "markov",       ...mk, conf: mk.confidence / 100 },
    { source: "cau",          ...pt, conf: pt.confidence / 100 },
    { source: "dice",         ...dc, conf: dc.confidence / 100 },
    { source: "oscillation",  ...os, conf: os.confidence / 100 },
    { source: "balance",      ...bl, conf: bl.confidence / 100 }
  ];

  const weights = getPredictorWeights();

  let weightedTai = 0, weightedXiu = 0, totalWeight = 0;
  let consensusTai = 0, consensusXiu = 0, consensusCount = 0;
  for (let p of preds) {
    if (!p.du_doan) continue;
    const w = weights[p.source] * (p.conf || 0.5);
    if (p.du_doan === "tài") {
      weightedTai += w;
      consensusTai++;
    } else if (p.du_doan === "xỉu") {
      weightedXiu += w;
      consensusXiu++;
    }
    consensusCount++;
    totalWeight += w;
  }

  if (totalWeight === 0 || consensusCount === 0) {
    // fallback dựa trên 5 phiên gần nhất
    const s5 = data.slice(0,5).filter(i=>i.ket_qua==='tài').length;
    return { du_doan: s5>=3?'tài':'xỉu', do_tin_cay: 51, loai_cau: 'không rõ', hanh_dong: '-' };
  }

  let finalSide, confidence;
  if (consensusCount >= 4 && (consensusTai >= 4 || consensusXiu >= 4)) {
    // Đồng thuận cao
    finalSide = consensusTai >= 4 ? "tài" : "xỉu";
    confidence = 85; // rất tự tin
  } else {
    const pTai = weightedTai / totalWeight;
    const pXiu = weightedXiu / totalWeight;
    finalSide = pTai >= pXiu ? "tài" : "xỉu";
    confidence = Math.round(Math.max(pTai, pXiu) * 100);
  }

  // Lấy loại cầu và hành động từ pattern nếu có
  let loai_cau = pt.loai_cau || "tổng hợp";
  let hanh_dong = pt.hanh_dong || (finalSide === data[0].ket_qua ? "THEO" : "BẺ");
  let canh_bao = `🎯 ${loai_cau} | ${finalSide} (độ tin cậy ${confidence}%)`;

  return {
    du_doan: finalSide, do_tin_cay: confidence, loai_cau, hanh_dong, canh_bao,
    thuat_toan: { markov: mk, cau: pt, dice: dc, oscillation: os, balance: bl, weights }
  };
}

// ─────────────────────────────────────────────
//  CẬP NHẬT THỐNG KÊ SAU MỖI PHIÊN (bao gồm recent10)
// ─────────────────────────────────────────────
function updatePredictorStats() {
  const checked = HISTORY.filter(h => h.checked);
  // Reset toàn bộ thống kê
  PREDICTOR_STATS = {
    markov:      { correct: 0, total: 0, recent10: { correct: 0, total: 0 } },
    cau:         { correct: 0, total: 0, recent10: { correct: 0, total: 0 } },
    dice:        { correct: 0, total: 0, recent10: { correct: 0, total: 0 } },
    oscillation: { correct: 0, total: 0, recent10: { correct: 0, total: 0 } },
    balance:     { correct: 0, total: 0, recent10: { correct: 0, total: 0 } }
  };

  // Duyệt toàn bộ lịch sử đã xác minh để tính overall
  for (let h of checked) {
    const actual = h.thuc_te;
    if (h.predicted) {
      for (let key of ['markov', 'cau', 'dice', 'oscillation', 'balance']) {
        if (h.predicted[key] && h.predicted[key].du_doan) {
          PREDICTOR_STATS[key].total++;
          if (h.predicted[key].du_doan === actual) PREDICTOR_STATS[key].correct++;
        }
      }
    }
  }

  // Tính recent10 (10 phiên gần nhất)
  const recent10 = checked.slice(-10);
  for (let h of recent10) {
    const actual = h.thuc_te;
    if (h.predicted) {
      for (let key of ['markov', 'cau', 'dice', 'oscillation', 'balance']) {
        if (h.predicted[key] && h.predicted[key].du_doan) {
          PREDICTOR_STATS[key].recent10.total++;
          if (h.predicted[key].du_doan === actual) PREDICTOR_STATS[key].recent10.correct++;
        }
      }
    }
  }

  // Cập nhật học bệt
  const arr = HISTORY.filter(h=>h.checked).map(h=>({ket_qua: h.thuc_te}));
  if (arr.length >= 3) {
    const streak = getStreak(arr);
    if (streak.count >= 3) {
      const key = streak.count;
      if (!STREAK_BREAK_MEMORY[key]) STREAK_BREAK_MEMORY[key] = { total: 0, broke: 0, defaultBreakProb: 0.5 };
      STREAK_BREAK_MEMORY[key].total++;
      if (arr.length > streak.count && arr[streak.count].ket_qua !== streak.side) {
        STREAK_BREAK_MEMORY[key].broke++;
      }
      if (STREAK_BREAK_MEMORY[key].total > 20) {
        STREAK_BREAK_MEMORY[key].total *= 0.8;
        STREAK_BREAK_MEMORY[key].broke *= 0.8;
      }
    }
  }
}

function verifyHistory(parsed) {
  const map = {};
  parsed.forEach(p => { map[p.phien] = p.ket_qua; });

  for (let h of HISTORY) {
    if (h.checked) continue;
    const real = map[h.phien_thuc_hien];
    if (real !== undefined) {
      h.checked = true;
      h.thuc_te = real;
      h.dung    = h.du_doan === real;
    }
  }
  if (HISTORY.length > 150) HISTORY = HISTORY.slice(-150);
}

function calcAccuracy() {
  const done = HISTORY.filter(h => h.checked);
  if (!done.length) return "chưa có dữ liệu";
  const correct = done.filter(h => h.dung).length;
  return ((correct / done.length) * 100).toFixed(1) + "%";
}

// ─────────────────────────────────────────────
//  MAIN UPDATE LOOP
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
      return {
        phien: item.id,
        ket_qua: item.resultTruyenThong === "TAI" ? "tài" : "xỉu",
        xuc_xac: `${x1}-${x2}-${x3}`,
        total: x1 + x2 + x3
      };
    });

    verifyHistory(parsed);

    const prediction = finalPredict(parsed);
    const latestPhien = parsed[0].phien;

    if (latestPhien !== lastPhien) {
      lastPhien = latestPhien;
      HISTORY.push({
        phien_du_doan: latestPhien,
        phien_thuc_hien: latestPhien + 1,
        du_doan: prediction.du_doan,
        loai_cau: prediction.loai_cau,
        hanh_dong: prediction.hanh_dong,
        do_tin_cay: prediction.do_tin_cay,
        predicted: prediction.thuat_toan || {},
        timestamp: new Date().toISOString(),
        checked: false,
        thuc_te: null,
        dung: null
      });
    }

    updatePredictorStats();

    const lastVerified = HISTORY.slice().reverse().find(h => h.checked);
    const ket_qua_gan_nhat = lastVerified ? {
      phien: lastVerified.phien_thuc_hien,
      du_doan: lastVerified.du_doan,
      thuc_te: lastVerified.thuc_te,
      dung: lastVerified.dung,
      icon: lastVerified.dung ? "✅" : "❌"
    } : null;

    CACHE = {
      phien:            latestPhien,
      ket_qua:          parsed[0].ket_qua,
      xuc_xac:          parsed[0].xuc_xac,
      du_doan:          prediction.du_doan,
      do_tin_cay:       prediction.do_tin_cay + "%",
      cau_dang_chay:    buildCauString(parsed, 12),
      loai_cau:         prediction.loai_cau,
      hanh_dong:        prediction.hanh_dong,
      canh_bao:         prediction.canh_bao,
      ty_le_tai:        Math.round(parsed.slice(0,10).filter(i=>i.ket_qua==='tài').length/10*100) + "%",
      ty_le_xiu:        Math.round(parsed.slice(0,10).filter(i=>i.ket_qua==='xỉu').length/10*100) + "%",
      ket_qua_gan_nhat,
      do_chinh_xac:     calcAccuracy(),
      thuat_toan:       prediction.thuat_toan,
      cap_nhat:         new Date().toLocaleTimeString("vi-VN")
    };

    console.log(`[${CACHE.cap_nhat}] #${latestPhien} | ${prediction.loai_cau} | ${prediction.hanh_dong} → ${prediction.du_doan} (${prediction.do_tin_cay}%) | Acc: ${CACHE.do_chinh_xac}`);
  } catch (err) {
    console.log("Lỗi API:", err.message);
  }
}

// ─────────────────────────────────────────────
//  ENDPOINTS
// ─────────────────────────────────────────────
app.get("/", (req, res) => res.json(CACHE));
app.get("/predict", (req, res) => res.json({ status: "success", data: CACHE }));
app.get("/algorithms", (req, res) => {
  res.json({
    status: "success",
    predictors: {
      markov: "Chuỗi Markov bậc 3 (fallback bậc 2)",
      cau: "Phân tích mẫu cầu nâng cao (1-1,2-2,3-3,4-4,bệt) + học xác suất bẻ cầu",
      dice: "Hồi quy trung bình & độ lệch chuẩn tổng điểm 10 phiên",
      oscillation: "Phát hiện dao động 1-1, 2-2 mở rộng",
      balance: "Cân bằng dài hạn (30 phiên), mean reversion",
      ensemble: "Bỏ phiếu có trọng số động dựa trên phong độ tổng thể & 10 phiên gần nhất, ưu tiên đồng thuận cao"
    },
    weights: getPredictorWeights(),
    streak_memory: STREAK_BREAK_MEMORY
  });
});
app.get("/accuracy", (req, res) => {
  res.json({
    status: "success",
    accuracy: calcAccuracy(),
    predictor_stats: PREDICTOR_STATS,
    history: HISTORY.slice(-30).reverse().map(h => ({
      phien_du_doan: h.phien_du_doan,
      phien_thuc_hien: h.phien_thuc_hien,
      du_doan: h.du_doan,
      loai_cau: h.loai_cau,
      hanh_dong: h.hanh_dong,
      thuc_te: h.thuc_te,
      dung: h.checked ? (h.dung ? "✅ ĐÚNG" : "❌ SAI") : "⏳ chờ"
    }))
  });
});

updateData();
setInterval(updateData, 5000);

app.listen(PORT, () => {
  console.log(`\n🎲 Tài Xỉu Adaptive Server — cổng ${PORT}`);
  console.log("  /            → trạng thái hiện tại");
  console.log("  /predict     → dự đoán");
  console.log("  /algorithms  → xem trọng số & bộ nhớ");
  console.log("  /accuracy    → lịch sử & thống kê\n`);
});