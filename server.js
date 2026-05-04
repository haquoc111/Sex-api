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
let CONSECUTIVE_ERRORS = 0; // đếm số lần sai liên tiếp để giảm rủi ro

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
//  PHÂN TÍCH XÚC XẮC (TỔNG ĐIỂM)
// ─────────────────────────────────────────────
function diceAnalysis(data) {
  if (data.length < 5) return { scoreTai: 50, scoreXiu: 50, reason: "chưa đủ dữ liệu" };

  const totals = data.slice(0, 15).map(i => i.total); // tối đa 15 phiên gần
  const n = totals.length;
  const sum = totals.reduce((a, b) => a + b, 0);
  const avg = sum / n;
  const median = totals.slice().sort((a,b)=>a-b)[Math.floor(n/2)];
  const last = totals[0];
  const last3 = totals.slice(0, 3);
  const avgLast3 = last3.reduce((a,b)=>a+b,0) / 3;

  // Tính xu hướng tổng (slope đơn giản)
  let slope = 0;
  if (n >= 6) {
    const xMean = (n - 1) / 2;
    const yMean = avg;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - xMean) * (totals[i] - yMean);
      den += (i - xMean) ** 2;
    }
    if (den !== 0) slope = num / den;
  }

  // Điểm dựa trên vị trí so với 11.5 (tài >= 11)
  // Cao hơn 11.5 -> nghiêng về tài, thấp hơn -> xỉu, nhưng có hồi quy
  let scoreTai = 50;
  let scoreXiu = 50;

  // Yếu tố 1: Giá trị trung bình
  if (avg > 12.5) { scoreTai -= 20; scoreXiu += 20; } // quá cao -> về xỉu
  else if (avg > 11.5) { scoreTai -= 10; scoreXiu += 10; }
  else if (avg < 9.5) { scoreTai += 20; scoreXiu -= 20; }
  else if (avg < 10.5) { scoreTai += 10; scoreXiu -= 10; }

  // Yếu tố 2: Phiên cuối cùng
  if (last >= 13) { scoreTai -= 15; scoreXiu += 15; }
  else if (last <= 8) { scoreTai += 15; scoreXiu -= 15; }
  else if (last >= 11) { scoreTai += 5; scoreXiu -= 5; }
  else if (last <= 10) { scoreTai -= 5; scoreXiu += 5; }

  // Yếu tố 3: Xu hướng (slope)
  if (slope > 0.3) { scoreTai += 10; scoreXiu -= 10; } // tổng đang tăng -> tài
  else if (slope < -0.3) { scoreTai -= 10; scoreXiu += 10; }

  // Yếu tố 4: Trung bình 3 phiên gần nhất
  if (avgLast3 > 12) { scoreTai -= 10; scoreXiu += 10; }
  else if (avgLast3 < 9) { scoreTai += 10; scoreXiu -= 10; }

  // Chuẩn hóa điểm trong khoảng 0-100
  scoreTai = Math.max(0, Math.min(100, scoreTai));
  scoreXiu = Math.max(0, Math.min(100, scoreXiu));

  return {
    scoreTai,
    scoreXiu,
    reason: `Avg=${avg.toFixed(1)} Last=${last} Slope=${slope.toFixed(2)}`
  };
}

// ─────────────────────────────────────────────
//  NHẬN DIỆN CẦU (PATTERN) MỀM DẺO
// ─────────────────────────────────────────────
function patternAnalysis(data) {
  if (data.length < 4) return { scoreTai: 50, scoreXiu: 50, loai_cau: "chưa đủ", hanh_dong: "-" };

  const arr = toArr(data);
  const n = arr.length;
  const streak = getStreak(data);
  const s10 = data.slice(0,10);
  const t10 = s10.filter(i=>i.ket_qua==='tài').length;
  const x10 = s10.length - t10;

  let scoreTai = 50, scoreXiu = 50;
  let loai_cau = "không rõ";
  let hanh_dong = "-";

  // 1. Cầu 1-1 (đảo liên tục) – mạnh
  if (n >= 5) {
    let is1_1 = true;
    for (let i = 0; i < 5; i++) {
      if (arr[i] === arr[i+1]) { is1_1 = false; break; }
    }
    if (is1_1) {
      const next = arr[0] === 'T' ? 'xỉu' : 'tài';
      loai_cau = "cầu 1-1";
      hanh_dong = "THEO";
      if (next === 'tài') { scoreTai = 85; scoreXiu = 15; }
      else { scoreTai = 15; scoreXiu = 85; }
      return { scoreTai, scoreXiu, loai_cau, hanh_dong };
    }
  }

  // 2. Cầu khối 2-2, 3-3, 4-4
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
    const next = blocks[blocks.length-1] === 'T' ? 'X' : 'T';
    return { side: next === 'T' ? 'tài' : 'xỉu', size };
  };

  for (let size of [4,3,2]) {
    const block = detectBlock(size);
    if (block) {
      loai_cau = `cầu ${size}-${size}`;
      hanh_dong = "THEO";
      if (block.side === 'tài') { scoreTai = 80; scoreXiu = 20; }
      else { scoreTai = 20; scoreXiu = 80; }
      return { scoreTai, scoreXiu, loai_cau, hanh_dong };
    }
  }

  // 3. Bệt
  if (streak.count >= 3) {
    const opposite = streak.side === 'tài' ? 'xỉu' : 'tài';
    if (streak.count >= 7) {
      // Bệt rất dài -> bẻ mạnh
      loai_cau = `bệt dài ${streak.side}`;
      hanh_dong = "BẺ";
      if (opposite === 'tài') { scoreTai = 70; scoreXiu = 30; }
      else { scoreTai = 30; scoreXiu = 70; }
    } else if (streak.count >= 4) {
      // Bệt trung bình -> bẻ nhẹ
      loai_cau = `bệt ${streak.side}`;
      hanh_dong = "BẺ";
      if (opposite === 'tài') { scoreTai = 65; scoreXiu = 35; }
      else { scoreTai = 35; scoreXiu = 65; }
    } else {
      // Bệt ngắn 3 -> theo hoặc bẻ tùy nghiêng
      if (t10 >= 6 && streak.side === 'tài') {
        loai_cau = `bệt ngắn ${streak.side} + nghiêng`;
        hanh_dong = "THEO";
        if (streak.side === 'tài') { scoreTai = 60; scoreXiu = 40; }
        else { scoreTai = 40; scoreXiu = 60; }
      } else if (x10 >= 6 && streak.side === 'xỉu') {
        loai_cau = `bệt ngắn ${streak.side} + nghiêng`;
        hanh_dong = "THEO";
        if (streak.side === 'tài') { scoreTai = 60; scoreXiu = 40; }
        else { scoreTai = 40; scoreXiu = 60; }
      } else {
        loai_cau = `bệt ngắn ${streak.side}`;
        hanh_dong = "BẺ";
        if (opposite === 'tài') { scoreTai = 55; scoreXiu = 45; }
        else { scoreTai = 45; scoreXiu = 55; }
      }
    }
    return { scoreTai, scoreXiu, loai_cau, hanh_dong };
  }

  // 4. Nghiêng 10 phiên
  if (t10 >= 8 || x10 >= 8) {
    const side = t10 >= 8 ? 'tài' : 'xỉu';
    loai_cau = `cực nghiêng ${side}`;
    hanh_dong = "BẺ";
    if (side === 'tài') { scoreTai = 25; scoreXiu = 75; }
    else { scoreTai = 75; scoreXiu = 25; }
  } else if (t10 >= 7 || x10 >= 7) {
    const side = t10 >= 7 ? 'tài' : 'xỉu';
    loai_cau = `nghiêng ${side}`;
    hanh_dong = "THEO";
    if (side === 'tài') { scoreTai = 65; scoreXiu = 35; }
    else { scoreTai = 35; scoreXiu = 65; }
  } else {
    // Không rõ ràng, dùng xu hướng 3 phiên gần nhất
    const last3 = data.slice(0,3).filter(i=>i.ket_qua==='tài').length;
    if (last3 >= 2) {
      loai_cau = "xu hướng ngắn tài";
      hanh_dong = "THEO";
      scoreTai = 60; scoreXiu = 40;
    } else {
      loai_cau = "xu hướng ngắn xỉu";
      hanh_dong = "THEO";
      scoreTai = 40; scoreXiu = 60;
    }
  }

  return { scoreTai, scoreXiu, loai_cau, hanh_dong };
}

// ─────────────────────────────────────────────
//  KẾT HỢP DỰ ĐOÁN (ENSEMBLE)
// ─────────────────────────────────────────────
function finalPredict(data) {
  const dice = diceAnalysis(data);
  const patt = patternAnalysis(data);

  // Trọng số: xúc xắc 60%, pattern 40% (coi trọng dữ liệu xúc xắc hơn)
  const wDice = 0.6, wPatt = 0.4;
  let finalTai = dice.scoreTai * wDice + patt.scoreTai * wPatt;
  let finalXiu = dice.scoreXiu * wDice + patt.scoreXiu * wPatt;

  // Điều chỉnh nếu đang có chuỗi sai liên tiếp -> giảm độ tự tin, nghiêng về an toàn
  if (CONSECUTIVE_ERRORS >= 2) {
    // giảm chênh lệch
    const mid = (finalTai + finalXiu) / 2;
    finalTai = mid + (finalTai - mid) * 0.5;
    finalXiu = mid + (finalXiu - mid) * 0.5;
  }

  let du_doan, confidence, hanh_dong, loai_cau;

  const diff = finalTai - finalXiu;
  if (diff > 0) {
    du_doan = "tài";
    confidence = Math.round(50 + diff * 0.5);
  } else {
    du_doan = "xỉu";
    confidence = Math.round(50 + (-diff) * 0.5);
  }

  // Giới hạn confidence 50-85
  confidence = Math.min(85, Math.max(50, confidence));

  // Xác định hành động và loại cầu từ pattern (để hiển thị)
  loai_cau = patt.loai_cau;
  hanh_dong = patt.hanh_dong;
  if (loai_cau === "không rõ") {
    loai_cau = `phân tích xúc xắc: ${dice.reason}`;
    hanh_dong = du_doan === data[0]?.ket_qua ? "THEO" : "BẺ";
  }

  // Chống dao động: nếu dự đoán mới trái ngược với dự đoán trước và độ tin cậy không cao hơn 10, giữ nguyên
  if (LAST_PREDICTION && LAST_PREDICTION.side !== du_doan) {
    if (confidence < LAST_PREDICTION.confidence + 10) {
      du_doan = LAST_PREDICTION.side;
      confidence = LAST_PREDICTION.confidence;
      loai_cau += " (giữ)";
    }
  }

  LAST_PREDICTION = { side: du_doan, confidence };

  const canh_bao = `🎯 ${loai_cau} | ${du_doan} (${confidence}%)`;

  return {
    du_doan,
    do_tin_cay: confidence,
    loai_cau,
    hanh_dong,
    canh_bao
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
      if (!h.dung) CONSECUTIVE_ERRORS++;
      else CONSECUTIVE_ERRORS = 0;
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
    method: "Phân tích xúc xắc (tổng, xu hướng, hồi quy) + nhận diện cầu thông minh, kết hợp ensemble"
  });
});

// Khởi động
updateData();
setInterval(updateData, 5000);

app.listen(PORT, () => {
  console.log(`\n🎲 Tài Xỉu AI v4 (Ổn định cao) — cổng ${PORT}`);
});