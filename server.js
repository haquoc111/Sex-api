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
  cap_nhat:         "",
  vip_signal:       null    // thêm tín hiệu VIP
};

let HISTORY = [];
let STATS_BY_CAU = {};

// ─────────────────────────────────────────────
//  HELPERS (giữ nguyên)
// ─────────────────────────────────────────────
function toArr(data) { return data.map(i => (i.ket_qua === "tài" ? "T" : "X")); }
function buildCauString(data, len = 15) { return toArr(data.slice(0, len)).join(""); }
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
  s.forEach(i => i.ket_qua === "tài" ? tai++ : xiu++);
  return { tai, xiu, total: s.length };
}

// ─────────────────────────────────────────────
//  NHẬN DIỆN CẦU NÂNG CAO (VIP)
// ─────────────────────────────────────────────
function detectAdvancedPatterns(data) {
  // bổ sung thêm các loại cầu hiếm: 2-1-2, 3-2, gãy giả
  const arr = toArr(data.slice(0, 40));
  const len = arr.length;
  if (len < 5) return null;

  // Cầu 2-1-2: T T X T T hoặc X X T X X (3-5 phiên)
  if (len >= 5) {
    const s5 = arr.slice(0,5).join('');
    if (s5 === 'TTXTT' || s5 === 'XXTXX') return { type: '2-1-2', breakSignal: false, score: 88, baseSide: arr[0] === 'T' ? 'tài' : 'xỉu' };
  }

  // Cầu 3-2: T T T X X hoặc X X X T T (5 phiên)
  if (len >= 5) {
    const s5 = arr.slice(0,5).join('');
    if (s5 === 'TTTXX' || s5 === 'XXXTT') return { type: '3-2', breakSignal: false, score: 85, baseSide: arr[0] === 'T' ? 'tài' : 'xỉu' };
  }

  // Cầu gãy giả (fake break): bệt 3, rồi 1 phiên ngược, rồi lại bệt 2
  if (len >= 6) {
    const s6 = arr.slice(0,6).join('');
    if (s6 === 'TTTXTT' || s6 === 'XXXTXX') return { type: 'gãy giả bệt', breakSignal: false, score: 90, baseSide: arr[0] === 'T' ? 'tài' : 'xỉu' };
  }

  // Nếu không tìm thấy cầu đặc biệt
  return null;
}

// ─────────────────────────────────────────────
//  BỘ LỌC SAFETY LOCK (cách chắn theo/bẻ)
// ─────────────────────────────────────────────
function safetyLock(prediction, data, advancedPattern) {
  const { du_doan, hanh_dong, canh_bao, do_tin_cay } = prediction;
  const streak = getStreak(data);
  let newCon = du_doan;
  let newHanhDong = hanh_dong;
  let newCanhBao = canh_bao;

  // Quy tắc 1: KHÔNG THEO QUÁ MẠNH
  if (hanh_dong === 'THEO') {
    if (prediction.loai_cau.startsWith('bệt') && streak.count >= 8) {
      // bệt quá dài -> chuyển sang chờ bẻ
      const inv = streak.side === 'tài' ? 'xỉu' : 'tài';
      newCon = inv;
      newHanhDong = 'BẺ';
      newCanhBao = `🛑 BỆT QUÁ DÀI (${streak.count}) -> CHỜ BẺ ${inv.toUpperCase()}`;
    } else if (prediction.loai_cau === '1-1' && prediction.streak >= 10) {
      const inv = du_doan === 'tài' ? 'xỉu' : 'tài';
      newCon = inv;
      newHanhDong = 'BẺ';
      newCanhBao = `🛑 1-1 QUÁ DÀI (${prediction.streak}) -> CHỜ BẺ ${inv.toUpperCase()}`;
    }
  }

  // Quy tắc 2: KHÔNG BẺ QUÁ MẠNH (cần ít nhất 2 AI đồng thuận)
  if (hanh_dong === 'BẺ') {
    const ai = prediction.thuat_toan?.ensemble;
    if (ai && ai.details) {
      // đếm số algorithm dự đoán cùng chiều với du_doan (bẻ)
      let agreeCount = 0;
      if (ai.details.markov.du_doan === du_doan) agreeCount++;
      if (ai.details.weighted.du_doan === du_doan) agreeCount++;
      if (ai.details.pattern.du_doan === du_doan) agreeCount++;
      if (ai.details.dice.du_doan === du_doan) agreeCount++;
      if (agreeCount < 2) {
        // không đủ đồng thuận -> không bẻ, giữ nguyên xu hướng hiện tại
        const cur = data[0].ket_qua;
        newCon = cur;
        newHanhDong = 'THEO';
        newCanhBao = `🔒 AN TOÀN: Chưa đủ tín hiệu bẻ (${agreeCount}/4 AI) → Theo ${cur.toUpperCase()}`;
      }
    }
  }

  // Quy tắc 3: Nếu có cầu VIP (advancedPattern) -> ưu tiên tín hiệu đó
  if (advancedPattern && !advancedPattern.breakSignal) {
    const side = advancedPattern.baseSide;
    newCon = side;
    newHanhDong = 'THEO';
    newCanhBao = `⭐ VIP CẦU ${advancedPattern.type} → THEO ${side.toUpperCase()}`;
  }

  return { du_doan: newCon, hanh_dong: newHanhDong, canh_bao: newCanhBao };
}

// ─────────────────────────────────────────────
//  CẬP NHẬT HÀM DỰ ĐOÁN CHÍNH
// ─────────────────────────────────────────────
function predict(data) {
  if (!data.length) return {
    du_doan: "tài", do_tin_cay: "50%", loai_cau: "chưa có dữ liệu",
    hanh_dong: "-", canh_bao: "chưa có dữ liệu",
    ty_le_tai: "0%", ty_le_xiu: "0%", thuat_toan: {}
  };

  const pattern  = analyzePattern(data); // hàm cũ giữ nguyên
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
    final_du_doan   = cau.du_doan;
    final_conf      = Math.min(72, Math.round(cau.conf * 0.88));
    final_canh_bao  = cau.canh_bao + " ⚠️AI=" + ensemble.du_doan.toUpperCase();
    final_hanh_dong = cau.hanh_dong;
  }

  // --- TÍCH HỢP ADVANCED PATTERN & SAFETY LOCK ---
  const advanced = detectAdvancedPatterns(data);
  const rawPrediction = {
    du_doan:    final_du_doan,
    do_tin_cay: Math.min(93, Math.max(52, final_conf)) + "%",
    loai_cau:   pattern.type,
    hanh_dong:  final_hanh_dong,
    canh_bao:   final_canh_bao,
    thuat_toan: ensemble ? { /* ... giữ nguyên ... */ } : {},
    streak:     getStreak(data).count
  };

  // áp dụng khóa an toàn + ưu tiên VIP
  const locked = safetyLock(rawPrediction, data, advanced);

  // Thêm đánh dấu VIP nếu có
  if (advanced) {
    locked.canh_bao = "⭐ " + locked.canh_bao;
    locked.do_tin_cay = Math.min(98, parseInt(locked.do_tin_cay) + 10) + "%";
  }

  const s10 = stats(data, 10);
  return {
    du_doan:        locked.du_doan,
    do_tin_cay:     locked.do_tin_cay,
    loai_cau:       pattern.type,
    hanh_dong:      locked.hanh_dong,
    canh_bao:       locked.canh_bao,
    ty_le_tai:      ((s10.tai / s10.total) * 100).toFixed(0) + "%",
    ty_le_xiu:      ((s10.xiu / s10.total) * 100).toFixed(0) + "%",
    thuat_toan:     rawPrediction.thuat_toan,
    vip_signal:     advanced ? { type: advanced.type, score: advanced.score } : null
  };
}

// ─────────────────────────────────────────────
//  GIỮ NGUYÊN CÁC HÀM KHÁC (analyzePattern, decideCau, ...)
//  (Không thay đổi để so sánh)
// ─────────────────────────────────────────────
// ... phần code cũ từ dòng 100 đến 350 vẫn giữ nguyên ...

// ─────────────────────────────────────────────
//  CẬP NHẬT ENDPOINT
// ─────────────────────────────────────────────
app.get("/", (req, res) => res.json(CACHE));
app.get("/predict", (req, res) => res.json({ status: "success", data: CACHE }));
app.get("/algorithms", (req, res) => res.json({
  status: "success",
  thuat_toan: CACHE.thuat_toan,
  vip_signal: CACHE.vip_signal,
  ghi_chu: {
    markov:   "Markov Chain bậc 2 — xác suất chuyển trạng thái",
    weighted: "Trọng số mũ — phiên gần ảnh hưởng nhiều hơn",
    pattern:  "Khớp mẫu 4 phiên cuối với lịch sử",
    dice:     "Xu hướng tổng điểm xúc xắc",
    ensemble: "Bỏ phiếu: markov×35% + weighted×25% + pattern×25% + dice×15%",
    vip:      "Phát hiện cầu nâng cao (2-1-2, 3-2, gãy giả) + Bộ lọc an toàn"
  }
}));

// ... phần còn lại giữ nguyên ...