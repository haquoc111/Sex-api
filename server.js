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

let MARKET_STATE = { trend: null, duration: 0 };

let PREDICTOR_STATS = {
  markov:      { correct: 0, total: 0, recent20: { correct: 0, total: 0 } },
  cau:         { correct: 0, total: 0, recent20: { correct: 0, total: 0 } },
  dice:        { correct: 0, total: 0, recent20: { correct: 0, total: 0 } },
  trend:       { correct: 0, total: 0, recent20: { correct: 0, total: 0 } },
  balance:     { correct: 0, total: 0, recent20: { correct: 0, total: 0 } },
  market_trend:{ correct: 0, total: 0, recent20: { correct: 0, total: 0 } }
};

let STREAK_BREAK_MEMORY = {};

let LAST_PREDICTION = null; // { side, confidence }

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
//  1. MARKOV
// ─────────────────────────────────────────────
function markovPredict(data) {
  const arr = toArr(data);
  if (arr.length < 5) return { du_doan: null, confidence: 0 };

  const order = arr.length >= 12 ? 3 : 2;
  const trans = {};
  const decay = 0.92;
  const laplace = 0.1;

  for (let i = 0; i < arr.length - order; i++) {
    const state = arr.slice(i, i + order).join("");
    const next  = arr[i + order];
    const weight = Math.pow(decay, i);
    if (!trans[state]) trans[state] = { T: laplace, X: laplace };
    trans[state][next] += weight;
  }

  const curState = arr.slice(0, order).join("");
  if (!trans[curState]) {
    if (order > 2) return markovPredict(data.slice(0, -1));
    const recent5 = data.slice(0,5).filter(i=>i.ket_qua==='tài').length;
    return { du_doan: recent5>=3?'tài':'xỉu', confidence: 55 };
  }

  const counts = trans[curState];
  const total = counts.T + counts.X;
  const pT = counts.T / total;
  const pX = counts.X / total;

  const entropy = -(pT * Math.log2(pT + 0.001) + pX * Math.log2(pX + 0.001));
  const maxEntropy = 1.0;
  let confidence = Math.round(Math.max(pT, pX) * 100);
  confidence = Math.round(confidence * (1 - entropy / maxEntropy * 0.5));
  const sampleCount = arr.length - order;
  if (sampleCount < 10) confidence = Math.min(confidence, 60 + sampleCount * 2);
  confidence = Math.min(85, confidence);

  return {
    du_doan: pT >= pX ? "tài" : "xỉu",
    confidence,
    samples: sampleCount
  };
}

// ─────────────────────────────────────────────
//  2. PATTERN NÂNG CAO
// ─────────────────────────────────────────────
function patternPredict(data) {
  if (data.length < 5) return { du_doan: null, confidence: 0, loai_cau: "chưa đủ" };
  const arr = toArr(data);
  const streak = getStreak(data);
  const s10 = data.slice(0,10);
  const t10 = s10.filter(i=>i.ket_qua==='tài').length;
  const x10 = s10.length - t10;

  // 1. Bệt
  if (streak.count >= 3) {
    const key = streak.count;
    if (!STREAK_BREAK_MEMORY[key]) {
      STREAK_BREAK_MEMORY[key] = { total: 0, broke: 0, default: 0.25 + key * 0.04 };
    }
    const mem = STREAK_BREAK_MEMORY[key];
    let breakProb = mem.total >= 4 ? mem.broke / mem.total : mem.default;
    breakProb = Math.min(0.85, breakProb);

    if (streak.count >= 5) {
      if (breakProb > 0.6) {
        return {
          du_doan: streak.side === 'tài' ? 'xỉu' : 'tài',
          confidence: Math.round(breakProb * 95),
          loai_cau: `bệt dài ${streak.side}`,
          hanh_dong: "BẺ"
        };
      } else {
        return {
          du_doan: streak.side,
          confidence: Math.round(Math.min(85, (1 - breakProb) * 100)),
          loai_cau: `bệt dài ${streak.side}`,
          hanh_dong: "THEO"
        };
      }
    } else {
      if (breakProb >= 0.55) {
        return {
          du_doan: streak.side === 'tài' ? 'xỉu' : 'tài',
          confidence: Math.round(breakProb * 90),
          loai_cau: `bệt ${streak.side}`,
          hanh_dong: "BẺ"
        };
      } else {
        return {
          du_doan: streak.side,
          confidence: Math.round(Math.min(80, (1 - breakProb) * 100)),
          loai_cau: `bệt ${streak.side}`,
          hanh_dong: "THEO"
        };
      }
    }
  }

  // 2. Gãy bệt dài
  if (data.length >= 6) {
    const secondStreak = getStreak(data.slice(1));
    if (secondStreak.count >= 5 && secondStreak.side !== streak.side && streak.count === 1) {
      return {
        du_doan: data[0].ket_qua,
        confidence: 78,
        loai_cau: `gãy bệt ${secondStreak.side}`,
        hanh_dong: "BẺ"
      };
    }
  }

  // 3. Cầu 1-1, 2-2, 3-3, 4-4
  const detectBlockPattern = (arr, size) => {
    if (arr.length < size * 2) return null;
    let blocks = [];
    let i = 0;
    while (i + size <= arr.length) {
      const block = arr.slice(i, i + size);
      if (block.every(v => v === block[0])) {
        blocks.push(block[0]);
        i += size;
      } else break;
    }
    if (blocks.length < 2) return null;
    for (let j = 1; j < blocks.length; j++) {
      if (blocks[j] === blocks[j-1]) return null;
    }
    const next = blocks[blocks.length - 1] === 'T' ? 'X' : 'T';
    return { side: next === 'T' ? 'tài' : 'xỉu', confidence: 82, loai_cau: `${size}-${size}` };
  };

  for (let size of [4, 3, 2, 1]) {
    const p = detectBlockPattern(arr, size);
    if (p) return { ...p, hanh_dong: "THEO" };
  }

  // 4. Nghiêng
  if (t10 >= 8 || x10 >= 8) {
    const recent3 = data.slice(0,3).map(i=>i.ket_qua);
    const hasReverse = recent3.some(kq => kq !== (t10>=8?'tài':'xỉu'));
    if (hasReverse) {
      return {
        du_doan: t10>=8 ? 'xỉu' : 'tài',
        confidence: 68,
        loai_cau: `nghiêng ${t10>=8?'tài':'xỉu'}`,
        hanh_dong: "BẺ"
      };
    } else {
      return {
        du_doan: t10>=8 ? 'tài' : 'xỉu',
        confidence: 70,
        loai_cau: `cực nghiêng ${t10>=8?'tài':'xỉu'}`,
        hanh_dong: "THEO"
      };
    }
  }

  if (t10 >= 7 || x10 >= 7) {
    return {
      du_doan: t10>=7 ? 'xỉu' : 'tài',
      confidence: 60,
      loai_cau: `nghiêng ${t10>=7?'tài':'xỉu'}`,
      hanh_dong: "BẺ"
    };
  }

  return { du_doan: null, confidence: 0, loai_cau: "không rõ" };
}

// ─────────────────────────────────────────────
//  3. DICE
// ─────────────────────────────────────────────
function dicePredict(data) {
  if (data.length < 8) return { du_doan: null, confidence: 0 };
  const totals = data.slice(0, 8).map(i => i.total);
  const avg = totals.reduce((a,b)=>a+b,0)/totals.length;
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const range = max - min;
  let conf = 65;
  if (range > 10) conf = 55;
  else if (range > 7) conf = 60;

  if (avg > 11.5) return { du_doan: "xỉu", confidence: conf };
  if (avg < 9.5)  return { du_doan: "tài", confidence: conf };
  if (avg > 11.0) return { du_doan: "xỉu", confidence: 55 };
  if (avg < 10.0) return { du_doan: "tài", confidence: 55 };
  return { du_doan: null, confidence: 0 };
}

// ─────────────────────────────────────────────
//  4. TREND
// ─────────────────────────────────────────────
function trendPredict(data) {
  if (data.length < 8) return { du_doan: null, confidence: 0 };
  const totals = data.slice(0, 8).map(i => i.total);
  const n = totals.length;
  const indices = Array.from({length: n}, (_, i) => i);
  const xMean = (n-1)/2;
  const yMean = totals.reduce((a,b)=>a+b,0)/n;
  const numerator = indices.reduce((s, x, i) => s + (x - xMean)*(totals[i] - yMean), 0);
  const denominator = indices.reduce((s, x) => s + (x - xMean)**2, 0);
  if (denominator === 0) return { du_doan: null, confidence: 0 };
  const slope = numerator / denominator;
  const yPred = indices.map(x => yMean + slope*(x - xMean));
  const ssRes = yPred.reduce((s, yp, i) => s + (totals[i] - yp)**2, 0);
  const ssTot = totals.reduce((s, y) => s + (y - yMean)**2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes/ssTot : 0;

  if (r2 < 0.3) return { du_doan: null, confidence: 0 };
  let conf = Math.round(55 + r2 * 20);
  conf = Math.min(75, conf);
  if (slope > 0.4) return { du_doan: "tài", confidence: conf };
  if (slope < -0.4) return { du_doan: "xỉu", confidence: conf };
  return { du_doan: null, confidence: 0 };
}

// ─────────────────────────────────────────────
//  5. BALANCE
// ─────────────────────────────────────────────
function balancePredict(data) {
  if (data.length < 30) return { du_doan: null, confidence: 0 };
  const sample = data.slice(0, 30);
  const tCount = sample.filter(i => i.ket_qua === 'tài').length;
  const ratio = tCount / 30;
  if (ratio > 0.58) return { du_doan: "xỉu", confidence: Math.round((ratio - 0.5) * 150) };
  if (ratio < 0.42) return { du_doan: "tài", confidence: Math.round((0.5 - ratio) * 150) };
  return { du_doan: null, confidence: 0 };
}

// ─────────────────────────────────────────────
//  ENTROPY & MODEL SELECTION
// ─────────────────────────────────────────────
function calcEntropy(data, len = 10) {
    const sample = data.slice(0, len);
    const tCount = sample.filter(i => i.ket_qua === 'tài').length;
    const ratio = tCount / sample.length;
    if (ratio === 0 || ratio === 1) return 0;
    return -(ratio * Math.log2(ratio) + (1 - ratio) * Math.log2(1 - ratio));
}

function getBestModels() {
    const stats = PREDICTOR_STATS;
    const models = ['markov', 'cau', 'dice', 'trend', 'balance']
        .map(key => ({
            name: key,
            acc: stats[key].recent20.total >= 5
                ? stats[key].recent20.correct / stats[key].recent20.total
                : (stats[key].total > 0 ? stats[key].correct / stats[key].total : 0.5),
            total: stats[key].recent20.total
        }))
        .filter(m => m.total >= 2 || m.acc > 0.55)
        .sort((a, b) => b.acc - a.acc);

    if (models.length === 0) {
        return ['markov', 'cau', 'dice', 'trend', 'balance'].map(name => ({ name, acc: 0.5 }));
    }
    return models.slice(0, 3); // top 3
}

// ─────────────────────────────────────────────
//  ENSEMBLE CUỐI CÙNG
// ─────────────────────────────────────────────
function finalPredict(data) {
    const mk = markovPredict(data);
    const pt = patternPredict(data);
    const dc = dicePredict(data);
    const tr = trendPredict(data);
    const bl = balancePredict(data);

    const predictions = { markov: mk, cau: pt, dice: dc, trend: tr, balance: bl };

    const last20 = data.slice(0, 20);
    const t20 = last20.filter(i => i.ket_qua === 'tài').length;
    const balanceRatio = t20 / last20.length;

    const bestModels = getBestModels();
    let weightedTai = 0, weightedXiu = 0, totalWeight = 0;

    // Model thị trường khi cực nghiêng
    if (balanceRatio > 0.7 || balanceRatio < 0.3) {
        const side = balanceRatio > 0.7 ? 'tài' : 'xỉu';
        const trendModel = { name: 'market_trend', du_doan: side, confidence: 75 };
        predictions.market_trend = trendModel;
        bestModels.unshift({ name: 'market_trend', acc: 0.8 });
    }

    for (let model of bestModels) {
        const pred = predictions[model.name];
        if (!pred || !pred.du_doan) continue;
        if (pred.confidence < 53 && model.name !== 'market_trend') continue;
        const w = model.acc * (pred.confidence / 100);
        if (pred.du_doan === "tài") weightedTai += w;
        else weightedXiu += w;
        totalWeight += w;
    }

    let finalSide, rawConfidence;
    if (totalWeight === 0) {
        const s5 = data.slice(0,5).filter(i=>i.ket_qua==='tài').length;
        finalSide = s5 >= 3 ? 'tài' : 'xỉu';
        rawConfidence = 53;
    } else {
        finalSide = weightedTai >= weightedXiu ? "tài" : "xỉu";
        rawConfidence = Math.round(Math.max(weightedTai, weightedXiu) / totalWeight * 100);
    }

    // --- KIỂM SOÁT CONFIDENCE ---
    let confidence = rawConfidence;

    // Không vượt quá 85%
    confidence = Math.min(85, confidence);

    // Phạt nếu tất cả model cùng ý (đồng thuận tuyệt đối)
    const allAgree = bestModels.every(model => {
        const p = predictions[model.name];
        return p && p.du_doan === finalSide;
    });
    if (allAgree && bestModels.length >= 3) {
        confidence = Math.round(confidence * 0.85);
    }

    // Phạt theo entropy thị trường (cầu cân bằng -> dễ đảo)
    const entropy = calcEntropy(data, 10);
    if (entropy > 0.85) {
        confidence = Math.round(confidence * 0.8);
    } else if (entropy > 0.7) {
        confidence = Math.round(confidence * 0.9);
    }

    // Đảm bảo tối thiểu
    confidence = Math.max(51, confidence);

    // --- CHỐNG DAO ĐỘNG ---
    if (LAST_PREDICTION && finalSide !== LAST_PREDICTION.side) {
        if (confidence < 58) {
            finalSide = LAST_PREDICTION.side;
            confidence = Math.max(confidence, LAST_PREDICTION.confidence - 4);
        } else {
            confidence = Math.max(confidence - 3, 55);
        }
    }

    LAST_PREDICTION = { side: finalSide, confidence };

    const loai_cau = pt.loai_cau || (balanceRatio > 0.55 ? 'thiên tài' : 'thiên xỉu');
    const hanh_dong = pt.hanh_dong || (finalSide === data[0].ket_qua ? "THEO" : "BẺ");

    return {
        du_doan: finalSide,
        do_tin_cay: confidence,
        loai_cau,
        hanh_dong,
        canh_bao: `🎯 ${loai_cau} | ${finalSide} (${confidence}%)`,
        thuat_toan: { markov: mk, cau: pt, dice: dc, trend: tr, balance: bl, bestModels: bestModels.map(m=>m.name) }
    };
}

// ─────────────────────────────────────────────
//  CẬP NHẬT THỐNG KÊ
// ─────────────────────────────────────────────
function updatePredictorStats() {
  const checked = HISTORY.filter(h => h.checked);
  const recent20 = checked.slice(-20);

  PREDICTOR_STATS = {
    markov:      { correct:0, total:0, recent20:{correct:0, total:0} },
    cau:         { correct:0, total:0, recent20:{correct:0, total:0} },
    dice:        { correct:0, total:0, recent20:{correct:0, total:0} },
    trend:       { correct:0, total:0, recent20:{correct:0, total:0} },
    balance:     { correct:0, total:0, recent20:{correct:0, total:0} },
    market_trend:{ correct:0, total:0, recent20:{correct:0, total:0} }
  };

  for (let h of checked) {
    const actual = h.thuc_te;
    if (h.predicted) {
      for (let key of Object.keys(PREDICTOR_STATS)) {
        if (h.predicted[key] && h.predicted[key].du_doan) {
          PREDICTOR_STATS[key].total++;
          if (h.predicted[key].du_doan === actual) PREDICTOR_STATS[key].correct++;
        }
      }
    }
  }

  for (let h of recent20) {
    const actual = h.thuc_te;
    if (h.predicted) {
      for (let key of Object.keys(PREDICTOR_STATS)) {
        if (h.predicted[key] && h.predicted[key].du_doan) {
          PREDICTOR_STATS[key].recent20.total++;
          if (h.predicted[key].du_doan === actual) PREDICTOR_STATS[key].recent20.correct++;
        }
      }
    }
  }

  // Cập nhật bộ nhớ bệt
  const arr = HISTORY.filter(h=>h.checked).map(h=>({ket_qua: h.thuc_te}));
  if (arr.length >= 3) {
    const streak = getStreak(arr);
    if (streak.count >= 3) {
      const key = streak.count;
      if (!STREAK_BREAK_MEMORY[key]) STREAK_BREAK_MEMORY[key] = { total:0, broke:0, default:0.25+key*0.04 };
      STREAK_BREAK_MEMORY[key].total++;
      if (arr.length > streak.count && arr[streak.count].ket_qua !== streak.side) {
        STREAK_BREAK_MEMORY[key].broke++;
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
      h.dung = h.du_doan === real;
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
  const best = getBestModels();
  res.json({
    status: "success",
    predictors: {
      markov: "Markov bậc 2/3 + Laplace smoothing",
      cau: "Pattern detector (1-1,2-2,3-3,4-4,bệt,nghiêng,gãy bệt)",
      dice: "Hồi quy trung bình tổng điểm + biên độ",
      trend: "Xu hướng tổng điểm (slope + R²)",
      balance: "Cân bằng dài hạn 30 phiên",
      market_trend: "Theo thị trường khi cực nghiêng"
    },
    best_models: best.map(m => ({ name: m.name, accuracy: m.acc.toFixed(2) })),
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
  console.log(`\n🎲 Tài Xỉu Pro Server v2 — cổng ${PORT}`);
  console.log("  /            → trạng thái hiện tại");
  console.log("  /predict     → dự đoán");
  console.log("  /algorithms  → top model & trọng số");
  console.log("  /accuracy    → lịch sử & thống kê\n`);
});