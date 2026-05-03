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

// Thống kê cho từng mô hình (tổng thể + 20 phiên gần)
let PREDICTOR_STATS = {
  markov:      { correct: 0, total: 0, recent20: { correct: 0, total: 0 } },
  cau:         { correct: 0, total: 0, recent20: { correct: 0, total: 0 } },
  dice:        { correct: 0, total: 0, recent20: { correct: 0, total: 0 } },
  trend:       { correct: 0, total: 0, recent20: { correct: 0, total: 0 } },
  balance:     { correct: 0, total: 0, recent20: { correct: 0, total: 0 } }
};

// Bộ nhớ bẻ cầu bệt
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
//  1. MARKOV CÓ TRỌNG SỐ THỜI GIAN (EMA)
// ─────────────────────────────────────────────
function markovPredict(data) {
  const arr = toArr(data);
  if (arr.length < 4) return { du_doan: null, confidence: 0 };

  const order = arr.length >= 8 ? 3 : 2;
  const trans = {};
  const decay = 0.9; // trọng số giảm dần cho các phiên cũ hơn

  for (let i = 0; i < arr.length - order; i++) {
    const state = arr.slice(i, i + order).join("");
    const next  = arr[i + order];
    const weight = Math.pow(decay, i); // phiên càng cũ (i lớn) thì trọng số nhỏ
    if (!trans[state]) trans[state] = { T: 0, X: 0 };
    trans[state][next] += weight;
  }

  const curState = arr.slice(0, order).join("");
  const counts   = trans[curState];
  if (!counts || counts.T + counts.X < 1) {
    return markovPredict(data.slice(0, -1)); // fallback bậc thấp hơn nếu cần
  }

  const total = counts.T + counts.X;
  const pT = counts.T / total;
  const pX = counts.X / total;
  return {
    du_doan: pT >= pX ? "tài" : "xỉu",
    confidence: Math.round(Math.max(pT, pX) * 90), // tối đa 90% vì không bao giờ chắc chắn
    samples: total
  };
}

// ─────────────────────────────────────────────
//  2. PHÂN TÍCH MẪU CẦU NÂNG CAO
// ─────────────────────────────────────────────
function patternPredict(data) {
  if (data.length < 5) return { du_doan: null, confidence: 0, loai_cau: "chưa đủ" };
  const arr = toArr(data);
  const streak = getStreak(data);

  // Cầu bệt
  if (streak.count >= 3) {
    const key = streak.count;
    if (!STREAK_BREAK_MEMORY[key]) {
      STREAK_BREAK_MEMORY[key] = { total: 0, broke: 0, default: 0.4 + (key-3)*0.08 };
    }
    const mem = STREAK_BREAK_MEMORY[key];
    let breakProb = mem.total >= 3 ? mem.broke / mem.total : mem.default;
    breakProb = Math.max(0.2, Math.min(0.9, breakProb));

    if (breakProb >= 0.55) {
      return {
        du_doan: streak.side === "tài" ? "xỉu" : "tài",
        confidence: Math.round(breakProb * 100),
        loai_cau: `bệt ${streak.side}`,
        hanh_dong: "BẺ"
      };
    } else {
      return {
        du_doan: streak.side,
        confidence: Math.round((1 - breakProb) * 100),
        loai_cau: `bệt ${streak.side}`,
        hanh_dong: "THEO"
      };
    }
  }

  // Các mẫu cầu khác (1-1, 2-2, 3-3, 4-4) kiểm tra chính xác hơn
  const detectPattern = (arr, blockSize) => {
    if (arr.length < blockSize * 2) return null;
    let blocks = [];
    let i = 0;
    while (i + blockSize <= arr.length) {
      const block = arr.slice(i, i + blockSize);
      if (block.every(v => v === block[0])) {
        blocks.push(block[0]);
        i += blockSize;
      } else break;
    }
    if (blocks.length < 2) return null;
    // Kiểm tra luân phiên
    for (let j = 1; j < blocks.length; j++) {
      if (blocks[j] === blocks[j-1]) return null; // không luân phiên
    }
    // Dự đoán block tiếp theo
    const nextSide = blocks[blocks.length - 1] === 'T' ? 'X' : 'T';
    return { du_doan: nextSide === 'T' ? 'tài' : 'xỉu', confidence: 80, loai_cau: `${blockSize}-${blockSize}` };
  };

  // Kiểm tra từ block size lớn đến nhỏ để ưu tiên mẫu mạnh hơn
  for (let size of [4, 3, 2]) {
    const p = detectPattern(arr, size);
    if (p) return { ...p, hanh_dong: "THEO" };
  }

  // Cầu 1-1
  let is11 = true;
  for (let i = 1; i < Math.min(6, arr.length); i++) {
    if (arr[i] === arr[i-1]) { is11 = false; break; }
  }
  if (is11 && arr.length >= 4) {
    const next = arr[0] === 'T' ? 'xỉu' : 'tài';
    return { du_doan: next, confidence: 75, loai_cau: "1-1", hanh_dong: "THEO" };
  }

  // Nghiêng 10 phiên
  const s10 = data.slice(0,10);
  const t10 = s10.filter(i=>i.ket_qua==='tài').length;
  if (t10 >= 7) return { du_doan: 'xỉu', confidence: 65, loai_cau: 'nghiêng tài', hanh_dong: 'BẺ' };
  if (t10 <= 3) return { du_doan: 'tài', confidence: 65, loai_cau: 'nghiêng xỉu', hanh_dong: 'BẺ' };

  return { du_doan: null, confidence: 0, loai_cau: "không rõ" };
}

// ─────────────────────────────────────────────
//  3. DỰ ĐOÁN THEO TỔNG ĐIỂM (cải tiến)
// ─────────────────────────────────────────────
function dicePredict(data) {
  if (data.length < 8) return { du_doan: null, confidence: 0 };
  const totals = data.slice(0, 8).map(i => i.total);
  const avg = totals.reduce((a,b)=>a+b,0)/totals.length;

  // Trung bình tổng điểm 3 xúc xắc là 10.5. Càng xa thì khả năng đảo chiều cao.
  if (avg > 11.8) return { du_doan: "xỉu", confidence: 72 };
  if (avg < 9.2)  return { du_doan: "tài", confidence: 72 };
  if (avg > 11.2) return { du_doan: "xỉu", confidence: 62 };
  if (avg < 9.8)  return { du_doan: "tài", confidence: 62 };
  return { du_doan: null, confidence: 0 };
}

// ─────────────────────────────────────────────
//  4. DỰ ĐOÁN THEO XU HƯỚNG TỔNG ĐIỂM (TREND)
// ─────────────────────────────────────────────
function trendPredict(data) {
  if (data.length < 6) return { du_doan: null, confidence: 0 };
  const totals = data.slice(0, 6).map(i => i.total);
  // Hồi quy tuyến tính đơn giản
  const n = totals.length;
  const indices = Array.from({length: n}, (_, i) => i);
  const xMean = (n-1)/2;
  const yMean = totals.reduce((a,b)=>a+b,0)/n;
  const num = indices.reduce((s, x, i) => s + (x - xMean)*(totals[i] - yMean), 0);
  const den = indices.reduce((s, x) => s + (x - xMean)**2, 0);
  if (den === 0) return { du_doan: null, confidence: 0 };
  const slope = num / den;

  if (slope > 0.5) return { du_doan: "tài", confidence: 65 };
  if (slope < -0.5) return { du_doan: "xỉu", confidence: 65 };
  // Nếu slope gần 0 -> sideway, theo tổng trung bình
  if (yMean > 10.5) return { du_doan: "tài", confidence: 55 };
  if (yMean < 10.5) return { du_doan: "xỉu", confidence: 55 };
  return { du_doan: null, confidence: 0 };
}

// ─────────────────────────────────────────────
//  5. CÂN BẰNG DÀI HẠN (30 phiên)
// ─────────────────────────────────────────────
function balancePredict(data) {
  if (data.length < 30) return { du_doan: null, confidence: 0 };
  const sample = data.slice(0, 30);
  const tCount = sample.filter(i => i.ket_qua === 'tài').length;
  const ratio = tCount / 30;
  if (ratio > 0.6) return { du_doan: "xỉu", confidence: Math.round((ratio - 0.5) * 200) };
  if (ratio < 0.4) return { du_doan: "tài", confidence: Math.round((0.5 - ratio) * 200) };
  return { du_doan: null, confidence: 0 };
}

// ─────────────────────────────────────────────
//  CHỌN MÔ HÌNH TỐT NHẤT TRONG 20 PHIÊN GẦN
// ─────────────────────────────────────────────
function getBestModels() {
  const stats = PREDICTOR_STATS;
  const models = ['markov', 'cau', 'dice', 'trend', 'balance']
    .map(key => ({
      name: key,
      recentAccuracy: stats[key].recent20.total >= 5
        ? stats[key].recent20.correct / stats[key].recent20.total
        : 0.5, // mặc định nếu chưa đủ dữ liệu
      overall: stats[key].total > 0 ? stats[key].correct / stats[key].total : 0.5
    }))
    .sort((a, b) => b.recentAccuracy - a.recentAccuracy);

  return models.slice(0, 2); // lấy 2 mô hình tốt nhất gần đây
}

// ─────────────────────────────────────────────
//  ENSEMBLE THÔNG MINH (chỉ dùng top 2 models + cơ chế đồng thuận)
// ─────────────────────────────────────────────
function finalPredict(data) {
  const mk = markovPredict(data);
  const pt = patternPredict(data);
  const dc = dicePredict(data);
  const tr = trendPredict(data);
  const bl = balancePredict(data);

  const predictions = { markov: mk, cau: pt, dice: dc, trend: tr, balance: bl };

  const bestModels = getBestModels();
  let weightedTai = 0, weightedXiu = 0;
  let totalWeight = 0;

  for (let model of bestModels) {
    const pred = predictions[model.name];
    if (!pred || !pred.du_doan) continue;
    const weight = model.recentAccuracy; // trọng số là độ chính xác gần đây
    if (pred.du_doan === "tài") weightedTai += weight;
    else weightedXiu += weight;
    totalWeight += weight;
  }

  // Nếu top 2 không đủ, mở rộng ra cả 5
  if (totalWeight === 0) {
    for (let key in predictions) {
      const p = predictions[key];
      if (!p || !p.du_doan) continue;
      const w = 0.6; // trọng số mặc định
      if (p.du_doan === "tài") weightedTai += w;
      else weightedXiu += w;
      totalWeight += w;
    }
  }

  if (totalWeight === 0) {
    const s3 = data.slice(0,3).filter(i=>i.ket_qua==='tài').length;
    return { du_doan: s3>=2?'tài':'xỉu', do_tin_cay: 51, loai_cau: 'fallback', hanh_dong: '-' };
  }

  const finalSide = weightedTai >= weightedXiu ? "tài" : "xỉu";
  const confidence = Math.min(95, Math.round(Math.max(weightedTai, weightedXiu) / totalWeight * 100));

  // Lấy thông tin cầu từ pattern (nếu có)
  const loai_cau = pt.loai_cau || (weightedTai > weightedXiu ? "thiên tài" : "thiên xỉu");
  const hanh_dong = pt.hanh_dong || (finalSide === data[0].ket_qua ? "THEO" : "BẺ");

  return {
    du_doan: finalSide,
    do_tin_cay: confidence,
    loai_cau,
    hanh_dong,
    canh_bao: `🎯 ${loai_cau} | ${finalSide} (${confidence}%)`,
    thuat_toan: { markov: mk, cau: pt, dice: dc, trend: tr, balance: bl, bestModels }
  };
}

// ─────────────────────────────────────────────
//  CẬP NHẬT THỐNG KÊ
// ─────────────────────────────────────────────
function updatePredictorStats() {
  const checked = HISTORY.filter(h => h.checked);
  const recent20 = checked.slice(-20);

  const reset = () => ({ correct: 0, total: 0, recent20: { correct: 0, total: 0 } });

  PREDICTOR_STATS = {
    markov: reset(), cau: reset(), dice: reset(), trend: reset(), balance: reset()
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
      if (!STREAK_BREAK_MEMORY[key]) STREAK_BREAK_MEMORY[key] = { total: 0, broke: 0, default: 0.5 };
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
  res.json({
    status: "success",
    predictors: {
      markov: "Markov EMA bậc 2/3",
      cau: "Phân tích mẫu cầu (1-1..4-4, bệt, nghiêng)",
      dice: "Hồi quy trung bình tổng điểm",
      trend: "Xu hướng tổng điểm (hồi quy tuyến tính)",
      balance: "Cân bằng dài hạn 30 phiên"
    },
    best_models: getBestModels().map(m => m.name),
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
  console.log(`\n🎲 Tài Xỉu Pro Server — cổng ${PORT}`);
  console.log("  /            → trạng thái hiện tại");
  console.log("  /predict     → dự đoán");
  console.log("  /algorithms  → xem top model & trọng số");
  console.log("  /accuracy    → lịch sử & thống kê\n`);
});