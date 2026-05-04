// server.js
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");

const app  = express();
app.use(cors());

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
//  NHẬN DIỆN CẦU NÂNG CAO (PATTERN) – phiên bản 2
// ─────────────────────────────────────────────
function patternPredict(data) {
  if (data.length < 4) return { du_doan: null, confidence: 0, loai_cau: "chưa đủ" };
  const arr = toArr(data);
  const n = arr.length;

  // Thống kê nhanh 10 phiên gần
  const last10 = data.slice(0, 10);
  const t10 = last10.filter(i => i.ket_qua === 'tài').length;
  const x10 = last10.length - t10;

  const streak = getStreak(data);

  // ----- 1. Phát hiện chu kỳ lặp (cycle) -----
  // tìm chu kỳ từ 2 đến 5, ưu tiên chu kỳ ngắn
  for (let L = 2; L <= 5; L++) {
    if (n < L * 2) continue;
    const seg1 = arr.slice(0, L);
    const seg2 = arr.slice(L, L * 2);
    if (seg1.join('') === seg2.join('')) {
      // Kiểm tra không phải toàn bộ giống nhau (bệt)
      if (new Set(seg1).size === 1) continue; // bỏ qua nếu là bệt lặp
      // Dự đoán: phần tử tiếp theo = phần tử đầu chu kỳ (seg1[0])
      const next = seg1[0] === 'T' ? 'tài' : 'xỉu';
      return {
        du_doan: next,
        confidence: 85,
        loai_cau: `chu kỳ ${L}`,
        hanh_dong: "THEO"
      };
    }
  }

  // ----- 2. Cầu 1-1 (đảo liên tục) -----
  if (n >= 4) {
    let is1_1 = true;
    for (let i = 0; i < Math.min(n - 1, 6); i++) {
      if (arr[i] === arr[i + 1]) { is1_1 = false; break; }
    }
    if (is1_1) {
      return {
        du_doan: arr[0] === 'T' ? 'xỉu' : 'tài',
        confidence: 82,
        loai_cau: "cầu 1-1",
        hanh_dong: "THEO"
      };
    }
  }

  // ----- 3. Cầu khối (block) 2-2, 3-3, 4-4 -----
  const detectBlock = (size) => {
    if (n < size * 2) return null;
    let blocks = [];
    let i = 0;
    while (i + size <= n) {
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
    const block = detectBlock(size);
    if (block) return { ...block, hanh_dong: "THEO" };
  }

  // ----- 4. Xử lý bệt (streak) -----
  if (streak.count >= 3) {
    const oppositeSide = streak.side === 'tài' ? 'xỉu' : 'tài';
    const oppositeCount = oppositeSide === 'tài' ? t10 : x10;
    const sameCount = streak.side === 'tài' ? t10 : x10;

    // Nếu bệt dài >=5 và thị trường ủng hộ (sameCount >=7) => THEO
    if (streak.count >= 5 && sameCount >= 7) {
      return {
        du_doan: streak.side,
        confidence: 78,
        loai_cau: `bệt dài ${streak.side} (ủng hộ)`,
        hanh_dong: "THEO"
      };
    }
    // Nếu bệt >=4 và bên kia áp đảo (oppositeCount >=7) => BẺ
    if (streak.count >= 4 && oppositeCount >= 7) {
      return {
        du_doan: oppositeSide,
        confidence: 72,
        loai_cau: `bẻ bệt ${streak.side} (đảo nghiêng)`,
        hanh_dong: "BẺ"
      };
    }
    // Các trường hợp còn lại
    if (streak.count >= 6) {
      // Bệt rất dài nhưng không có ủng hộ rõ => vẫn bẻ an toàn
      return {
        du_doan: oppositeSide,
        confidence: 65,
        loai_cau: `bệt rất dài ${streak.side}`,
        hanh_dong: "BẺ"
      };
    }
    if (streak.count >= 4) {
      // Bệt 4-5: bẻ nếu oppositeCount >= 4
      if (oppositeCount >= 4) {
        return {
          du_doan: oppositeSide,
          confidence: 62,
          loai_cau: `bẻ bệt ${streak.side}`,
          hanh_dong: "BẺ"
        };
      } else {
        return {
          du_doan: streak.side,
          confidence: 60,
          loai_cau: `bệt ${streak.side} (theo)`,
          hanh_dong: "THEO"
        };
      }
    }
    // Bệt 3
    if (oppositeCount >= 5) {
      return {
        du_doan: oppositeSide,
        confidence: 58,
        loai_cau: `bẻ bệt ngắn ${streak.side}`,
        hanh_dong: "BẺ"
      };
    } else {
      return {
        du_doan: streak.side,
        confidence: 57,
        loai_cau: `bệt ngắn ${streak.side}`,
        hanh_dong: "THEO"
      };
    }
  }

  // ----- 5. Nghiêng 10 phiên -----
  if (t10 >= 7 || x10 >= 7) {
    const side = t10 >= 7 ? 'tài' : 'xỉu';
    if (t10 >= 8 || x10 >= 8) {
      // cực nghiêng -> bẻ
      return {
        du_doan: side === 'tài' ? 'xỉu' : 'tài',
        confidence: 70,
        loai_cau: `cực nghiêng ${side}`,
        hanh_dong: "BẺ"
      };
    } else {
      // 7-3 -> theo xu hướng
      return {
        du_doan: side,
        confidence: 66,
        loai_cau: `nghiêng ${side}`,
        hanh_dong: "THEO"
      };
    }
  }

  // ----- 6. Không rõ -> xu hướng 3 phiên gần nhất -----
  const last3 = data.slice(0, 3).filter(i => i.ket_qua === 'tài').length;
  if (last3 >= 2) {
    return { du_doan: 'tài', confidence: 55, loai_cau: 'xu hướng ngắn', hanh_dong: 'THEO' };
  } else if (last3 <= 1) {
    return { du_doan: 'xỉu', confidence: 55, loai_cau: 'xu hướng ngắn', hanh_dong: 'THEO' };
  }

  return { du_doan: null, confidence: 0, loai_cau: "không rõ" };
}

// ─────────────────────────────────────────────
//  DỰ ĐOÁN CUỐI CÙNG
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

  // Fallback an toàn
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
    sessions = sessions.slice(0, 50);

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
    method: "Nhận diện cầu nâng cao: chu kỳ, 1-1, block, bệt thông minh + phân tích thị trường"
  });
});

// Khởi động
updateData();
setInterval(updateData, 5000);

app.listen(PORT, () => {
  console.log(`\n🎲 Tài Xỉu AI v3 — cổng ${PORT}`);
});