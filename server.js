// server.js
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");

const app  = express();
app.use(cors()); // Cho phép mọi nguồn gọi API

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
let LAST_PREDICTION = null;

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
//  1. NHẬN DIỆN CẦU NHANH (PATTERN) – nòng cốt
// ─────────────────────────────────────────────
function patternPredict(data) {
  if (data.length < 4) return { du_doan: null, confidence: 0, loai_cau: "chưa đủ" };
  const arr = toArr(data);
  const streak = getStreak(data);

  // 1. Cầu 1-1 (đảo liên tục) – phát hiện ngay từ 4 phiên
  if (arr.length >= 4) {
    const last4 = arr.slice(0, 4);
    if (last4[0] !== last4[1] && last4[1] !== last4[2] && last4[2] !== last4[3]) {
      return {
        du_doan: last4[0] === 'T' ? 'xỉu' : 'tài',
        confidence: 82,
        loai_cau: "cầu 1-1",
        hanh_dong: "THEO"
      };
    }
  }

  // 2. Cầu 2-2, 3-3, 4-4
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
    return { side: next === 'T' ? 'tài' : 'xỉu', confidence: 85, loai_cau: `${size}-${size}` };
  };

  for (let size of [4, 3, 2]) {
    const p = detectBlockPattern(arr, size);
    if (p) return { ...p, hanh_dong: "THEO" };
  }

  // 3. Bệt (streak) – bẻ cầu mạnh tay hơn
  if (streak.count >= 3) {
    const breakProb = 0.45 + streak.count * 0.05; // tăng dần theo độ dài bệt
    if (streak.count >= 6) {
      return {
        du_doan: streak.side === 'tài' ? 'xỉu' : 'tài',
        confidence: Math.round(breakProb * 100),
        loai_cau: `bệt dài ${streak.side}`,
        hanh_dong: "BẺ"
      };
    } else if (streak.count >= 4) {
      return {
        du_doan: streak.side === 'tài' ? 'xỉu' : 'tài',
        confidence: Math.round(breakProb * 90),
        loai_cau: `bệt ${streak.side}`,
        hanh_dong: "BẺ"
      };
    } else { // streak 3
      return {
        du_doan: streak.side === 'tài' ? 'xỉu' : 'tài',
        confidence: 60,
        loai_cau: `bệt ngắn ${streak.side}`,
        hanh_dong: "BẺ"
      };
    }
  }

  // 4. Nghiêng nhẹ (7-3, 6-4 trong 10) → bẻ
  const s10 = data.slice(0,10);
  const t10 = s10.filter(i=>i.ket_qua==='tài').length;
  const x10 = s10.length - t10;
  if (t10 >= 7 || x10 >= 7) {
    return {
      du_doan: t10>=7 ? 'xỉu' : 'tài',
      confidence: 65,
      loai_cau: `nghiêng ${t10>=7?'tài':'xỉu'}`,
      hanh_dong: "BẺ"
    };
  }

  // 5. Nếu không rõ ràng, dùng xu hướng nhẹ 3 phiên gần nhất
  const last3 = data.slice(0,3).filter(i=>i.ket_qua==='tài').length;
  if (last3 >= 2) {
    return { du_doan: 'tài', confidence: 58, loai_cau: 'xu hướng ngắn', hanh_dong: 'THEO' };
  } else if (last3 <= 1) {
    return { du_doan: 'xỉu', confidence: 58, loai_cau: 'xu hướng ngắn', hanh_dong: 'THEO' };
  }

  return { du_doan: null, confidence: 0, loai_cau: "không rõ" };
}

// ─────────────────────────────────────────────
//  2. DỰ ĐOÁN CUỐI CÙNG (chỉ dùng pattern)
// ─────────────────────────────────────────────
function finalPredict(data) {
  const pt = patternPredict(data);
  if (pt.du_doan) {
    LAST_PREDICTION = { side: pt.du_doan, confidence: pt.confidence };
    return {
      du_doan: pt.du_doan,
      do_tin_cay: pt.confidence,
      loai_cau: pt.loai_cau,
      hanh_dong: pt.hanh_dong,
      canh_bao: `🎯 ${pt.loai_cau} | ${pt.du_doan} (${pt.confidence}%)`
    };
  }

  // Fallback: random nhẹ theo phiên gần nhất
  const last = data[0]?.ket_qua;
  const fallback = last === 'tài' ? 'xỉu' : 'tài';
  LAST_PREDICTION = { side: fallback, confidence: 50 };
  return {
    du_doan: fallback,
    do_tin_cay: 50,
    loai_cau: "không rõ",
    hanh_dong: "BẺ",
    canh_bao: "⚠️ Không rõ cầu - bẻ ngược"
  };
}

// ─────────────────────────────────────────────
//  CẬP NHẬT & KIỂM TRA LỊCH SỬ
// ─────────────────────────────────────────────
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
  if (HISTORY.length > 100) HISTORY = HISTORY.slice(-100);
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
    sessions = sessions.slice(0, 50); // Giảm để nhạy hơn với thay đổi

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
        timestamp: new Date().toISOString(),
        checked: false,
        thuc_te: null,
        dung: null
      });
    }

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
    method: "Nhận diện cầu nhanh (1-1, 2-2, 3-3, bệt ngắn, nghiêng) + bẻ cầu nét"
  });
});

// Khởi động
updateData();
setInterval(updateData, 5000); // Cập nhật mỗi 5 giây

app.listen(PORT, () => {
  console.log(`\n🎲 Tài Xỉu AI v2 — cổng ${PORT}`);
});