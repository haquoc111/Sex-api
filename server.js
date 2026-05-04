// server.js — Tài Xỉu AI v5 (Thuật toán nét, bền, bẻ cầu thông minh)
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");

const app = express();
app.use(cors());

const PORT    = process.env.PORT || 3000;
const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=62385f65eb49fcb34c72a7d6489ad91d";

// ═══════════════════════════════════════════════════════════
//  GLOBAL STATE
// ═══════════════════════════════════════════════════════════
let CACHE = {
  phien: "0", ket_qua: "đang tải", xuc_xac: "0-0-0",
  du_doan: "đang phân tích", do_tin_cay: "0%",
  cau_dang_chay: "-", loai_cau: "đang phân tích",
  hanh_dong: "-", canh_bao: "đang tải",
  ty_le_tai: "0%", ty_le_xiu: "0%",
  ket_qua_gan_nhat: null, do_chinh_xac: "chưa có",
  recent_accuracy: "chưa có", cap_nhat: ""
};

let HISTORY          = [];   // lịch sử dự đoán
let LAST_PREDICTION  = null; // { side, confidence, pattern_type }
let CONSECUTIVE_ERRORS = 0;
let PATTERN_STATE    = {     // trạng thái cầu đang theo dõi
  type: null,    // '1-1' | 'block' | 'bet' | 'lean'
  startPhien: 0,
  length: 0,
  wrongCount: 0  // số lần sai kể từ khi phát hiện cầu này
};

// ═══════════════════════════════════════════════════════════
//  TIỆN ÍCH
// ═══════════════════════════════════════════════════════════
const toTX  = (item) => item.ket_qua === "tài" ? "T" : "X";
const toArr = (data) => data.map(toTX);
const opp   = (side) => side === "tài" ? "xỉu" : "tài";
const oppTX = (c)    => c === "T" ? "X" : "T";

function buildCauString(data, len = 15) {
  return toArr(data.slice(0, len)).join("");
}

// Đếm streak hiện tại (arr[0] = mới nhất)
function getStreak(arr) {
  if (!arr.length) return { val: "T", length: 0 };
  const val = arr[0];
  let len = 1;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === val) len++;
    else break;
  }
  return { val, length: len };
}

// ═══════════════════════════════════════════════════════════
//  PHÂN TÍCH XÚC XẮC — trả về score nghiêng về Tài hay Xỉu
//  Chú trọng xu hướng & biên độ dao động để phát hiện bẻ cầu
// ═══════════════════════════════════════════════════════════
function diceAnalysis(data) {
  const raw = data.slice(0, 20).map(i => i.total);
  const n   = raw.length;
  if (n < 4) return { bias: 0, volatile: false, reason: "ít dữ liệu" };

  // Trung bình & phương sai rolling 5 phiên gần nhất
  const last5  = raw.slice(0, 5);
  const avg5   = last5.reduce((a, b) => a + b, 0) / last5.length;
  const var5   = last5.reduce((s, v) => s + (v - avg5) ** 2, 0) / last5.length;
  const stdDev = Math.sqrt(var5);

  // Xu hướng tuyến tính (slope) — dương: tổng đang tăng → tài
  // arr[0] = mới nhất, nên slope dương = gần đây cao hơn = đang tăng
  const xMean = (n - 1) / 2;
  const yMean = raw.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (raw[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  // slope dương khi index lớn (xa, cũ hơn) có giá trị lớn
  // Vì arr[0] = mới nhất, slope dương nghĩa là phiên CŨ cao, MỚI thấp → đang giảm → nghiêng XỈU
  // Ngược lại slope âm → đang tăng → nghiêng TÀI
  const trendBias = -slope * 3; // âm slope = tài

  // Hồi quy về trung bình: nếu 5 phiên gần quá cao/thấp, khả năng đảo
  let reversionBias = 0;
  if (avg5 > 13.5)      reversionBias = -15; // quá tài → sắp xỉu
  else if (avg5 > 12.5) reversionBias = -8;
  else if (avg5 < 8.5)  reversionBias = +15; // quá xỉu → sắp tài
  else if (avg5 < 9.5)  reversionBias = +8;

  // Phiên gần nhất
  const lastTotal = raw[0];
  let lastBias = 0;
  if (lastTotal >= 14)      lastBias = -10;
  else if (lastTotal >= 12) lastBias = -4;
  else if (lastTotal <= 7)  lastBias = +10;
  else if (lastTotal <= 9)  lastBias = +4;

  // Độ biến động: stdDev > 3.5 → xúc xắc đang nhiễu loạn → cờ bẻ cầu
  const volatile = stdDev > 3.2;

  const bias = trendBias + reversionBias + lastBias;

  return {
    bias,        // dương = nghiêng tài, âm = nghiêng xỉu
    volatile,    // true = xúc xắc mất ổn định (tín hiệu bẻ cầu)
    avg5: avg5.toFixed(1),
    stdDev: stdDev.toFixed(2),
    slope: slope.toFixed(3),
    reason: `avg5=${avg5.toFixed(1)} std=${stdDev.toFixed(2)} slope=${slope.toFixed(2)}`
  };
}

// ═══════════════════════════════════════════════════════════
//  PHÁT HIỆN CẦU — ưu tiên từ mạnh → yếu
// ═══════════════════════════════════════════════════════════

// Cầu 1-1: đếm số lần xen kẽ liên tục từ đầu
function detect1_1(arr) {
  if (arr.length < 4) return null;
  let altLen = 1;
  for (let i = 1; i < arr.length && i < 25; i++) {
    if (arr[i] !== arr[i - 1]) altLen++;
    else break;
  }
  if (altLen < 4) return null;
  return { type: "1-1", length: altLen, next: oppTX(arr[0]) };
}

// Cầu khối size-size: TTXX, TTTXXX, TTTTXXXX...
function detectBlock(arr) {
  for (const size of [4, 3, 2]) {
    const minLen = size * 2; // ít nhất 2 khối xác nhận
    if (arr.length < minLen) continue;

    // Đọc từng khối từ đầu (mới nhất)
    let idx = 0;
    let blocks = [];
    while (idx + size <= arr.length) {
      const chunk = arr.slice(idx, idx + size);
      const val   = chunk[0];
      if (chunk.every(v => v === val)) {
        blocks.push(val);
        idx += size;
      } else break;
    }

    // Cần ít nhất 2 khối hoàn chỉnh & xen kẽ nhau
    if (blocks.length < 2) continue;
    let alternating = true;
    for (let i = 1; i < blocks.length; i++) {
      if (blocks[i] === blocks[i - 1]) { alternating = false; break; }
    }
    if (!alternating) continue;

    // Khối đầu tiên (arr[0..size-1]) = khối mới nhất, đang chạy
    // Nếu khối này đủ `size` → dự đoán khối tiếp (đối nghịch)
    const currentBlockVal = arr[0];
    const currentBlockLen = (() => {
      let c = 0;
      for (let i = 0; i < arr.length && arr[i] === currentBlockVal; i++) c++;
      return c;
    })();

    const nextSide = oppTX(currentBlockVal);
    return {
      type: `${size}-${size}`,
      size,
      blocksFound: blocks.length,
      currentBlockLen,
      next: nextSide
    };
  }
  return null;
}

// Cầu bệt + logic thông minh theo/bẻ dựa trên độ dài & xúc xắc
function analyzeBet(arr, diceInfo) {
  const streak = getStreak(arr);
  const len    = streak.length;
  const side   = streak.val === "T" ? "tài" : "xỉu";

  if (len < 2) return null; // chưa thành bệt

  let action, confidence, label;

  if (len >= 9) {
    // Bệt cực dài → BẺ mạnh
    action     = "BẺ";
    confidence = 78;
    label      = `bệt siêu dài ${side} (bẻ mạnh)`;
  } else if (len >= 7) {
    // Bệt dài → BẺ, nhưng xem dice
    if (diceInfo.volatile) {
      action     = "BẺ";
      confidence = 74;
    } else {
      action     = "BẺ";
      confidence = 68;
    }
    label = `bệt dài ${side} (bẻ)`;
  } else if (len >= 5) {
    // Bệt trung-dài → THEO nhưng chú ý dice
    // Nếu dice volatile hoặc bias mạnh ngược chiều → BẺ sớm
    const biasAgainst = (streak.val === "T" && diceInfo.bias < -10) ||
                        (streak.val === "X" && diceInfo.bias > 10);
    if (diceInfo.volatile && biasAgainst) {
      action     = "BẺ";
      confidence = 65;
      label      = `bệt dài ${side} (ủng hộ → dice bẻ)`;
    } else {
      action     = "THEO";
      confidence = 72;
      label      = `bệt dài ${side} (ủng hộ)`;
    }
  } else if (len >= 3) {
    // Bệt ngắn → THEO theo + xét dice để tăng/giảm tin cậy
    const biasConfirm = (streak.val === "T" && diceInfo.bias > 5) ||
                        (streak.val === "X" && diceInfo.bias < -5);
    if (biasConfirm) {
      action     = "THEO";
      confidence = 68;
      label      = `bệt ${side} (dice xác nhận)`;
    } else {
      action     = "THEO";
      confidence = 60;
      label      = `bệt ngắn ${side}`;
    }
  } else {
    // Bệt 2 → THEO nhẹ
    action     = "THEO";
    confidence = 56;
    label      = `bệt đôi ${side}`;
  }

  const next = action === "THEO" ? streak.val : oppTX(streak.val);
  return { type: "bet", length: len, label, action, next, confidence, side };
}

// Phân tích nghiêng tổng 10 phiên
function analyzeLean(arr, diceInfo) {
  const slice10 = arr.slice(0, 10);
  const tCount  = slice10.filter(v => v === "T").length;
  const xCount  = slice10.length - tCount;

  let next, label, confidence;

  if (tCount >= 8) {
    // Cực nghiêng tài → BẺ về xỉu
    next       = "X";
    label      = "cực nghiêng tài → bẻ xỉu";
    confidence = 70;
  } else if (xCount >= 8) {
    next       = "T";
    label      = "cực nghiêng xỉu → bẻ tài";
    confidence = 70;
  } else if (tCount >= 7) {
    next       = "T"; // tiếp tục theo nghiêng
    label      = "nghiêng tài (theo)";
    confidence = 62;
  } else if (xCount >= 7) {
    next       = "X";
    label      = "nghiêng xỉu (theo)";
    confidence = 62;
  } else {
    return null; // không rõ nghiêng
  }

  // Dice xác nhận
  if ((next === "T" && diceInfo.bias > 8) || (next === "X" && diceInfo.bias < -8)) {
    confidence = Math.min(confidence + 8, 82);
  }

  return { type: "lean", label, next, confidence, tCount, xCount };
}

// ═══════════════════════════════════════════════════════════
//  PHÁT HIỆN BẺ CẦU SỚM (Early Break Signal)
//  Khi cầu đang chạy đột nhiên có dấu hiệu phá vỡ
// ═══════════════════════════════════════════════════════════
function earlyBreakSignal(arr, diceInfo, currentPatternType) {
  if (!currentPatternType) return null;
  const signals = [];

  // Tín hiệu 1: Xúc xắc biến động cao + 1 phiên sai pattern
  if (diceInfo.volatile) signals.push("xúc xắc bất ổn");

  // Tín hiệu 2: Cầu 1-1 bị phá bởi 2 phiên giống nhau
  if (currentPatternType === "1-1") {
    if (arr.length >= 2 && arr[0] === arr[1]) {
      signals.push("cầu 1-1 bị phá (đôi xuất hiện)");
    }
  }

  // Tín hiệu 3: Bệt dài + dice hồi quy mạnh
  if (currentPatternType === "bet" && diceInfo.bias && Math.abs(diceInfo.bias) > 12) {
    const streak = getStreak(arr);
    if (streak.length >= 5) signals.push("bệt dài + dice đảo chiều mạnh");
  }

  // Tín hiệu 4: Xúc xắc cuối cùng có kết quả cực đoan (hồi quy)
  if (diceInfo.bias && Math.abs(diceInfo.bias) >= 18) {
    signals.push("dice cực đoan → hồi quy");
  }

  return signals.length >= 2 ? signals : null;
}

// ═══════════════════════════════════════════════════════════
//  DỰ ĐOÁN CUỐI CÙNG (CORE)
// ═══════════════════════════════════════════════════════════
function finalPredict(data) {
  if (data.length < 4) {
    return {
      du_doan: "tài", do_tin_cay: 50,
      loai_cau: "chưa đủ dữ liệu", hanh_dong: "-",
      canh_bao: "⏳ Đang thu thập dữ liệu...", dice_info: {}
    };
  }

  const arr      = toArr(data);
  const diceInfo = diceAnalysis(data);

  // ── Bước 1: Nhận diện các cầu theo thứ tự ưu tiên ──────
  const alt1_1  = detect1_1(arr);
  const block   = detectBlock(arr);
  const bet     = analyzeBet(arr, diceInfo);
  const lean    = analyzeLean(arr, diceInfo);

  // ── Bước 2: Kiểm tra tín hiệu bẻ cầu sớm ──────────────
  const breakSignals = earlyBreakSignal(arr, diceInfo, PATTERN_STATE.type);

  // ── Bước 3: Chọn strategy theo ưu tiên ──────────────────
  let chosen = null; // { next:'T'|'X', confidence, label, action, type }

  // Ưu tiên 1 — Cầu 1-1 rõ ràng (>= 5 phiên)
  if (alt1_1 && alt1_1.length >= 5 && !breakSignals) {
    const conf = Math.min(55 + alt1_1.length * 3, 82);
    chosen = {
      next: alt1_1.next,
      confidence: conf,
      label: `cầu 1-1 (${alt1_1.length} phiên)`,
      action: "THEO",
      type: "1-1"
    };
  }

  // Ưu tiên 2 — Cầu khối rõ ràng
  if (!chosen && block) {
    const conf = Math.min(58 + block.blocksFound * 6 + block.size * 3, 83);
    chosen = {
      next: block.next,
      confidence: conf,
      label: `cầu ${block.type} (${block.blocksFound} khối)`,
      action: "THEO",
      type: `block-${block.size}`
    };
  }

  // Ưu tiên 3 — Tín hiệu bẻ cầu sớm (override nếu pattern state có dấu hiệu vỡ)
  if (!chosen && breakSignals && LAST_PREDICTION) {
    const breakToward = oppTX(arr[0]); // bẻ ngược chiều phiên mới nhất
    chosen = {
      next: breakToward,
      confidence: 67,
      label: `⚠️ bẻ cầu sớm (${breakSignals[0]})`,
      action: "BẺ",
      type: "early-break"
    };
  }

  // Ưu tiên 4 — Bệt
  if (!chosen && bet && bet.length >= 2) {
    chosen = {
      next: bet.next,
      confidence: bet.confidence,
      label: bet.label,
      action: bet.action,
      type: "bet"
    };
  }

  // Ưu tiên 5 — Nghiêng 10 phiên
  if (!chosen && lean) {
    chosen = {
      next: lean.next,
      confidence: lean.confidence,
      label: lean.label,
      action: lean.tCount >= 8 || lean.xCount >= 8 ? "BẺ" : "THEO",
      type: "lean"
    };
  }

  // Ưu tiên 6 — Dice-only (fallback)
  if (!chosen) {
    const diceSide = diceInfo.bias >= 0 ? "T" : "X";
    const conf     = Math.min(52 + Math.abs(diceInfo.bias) * 0.4, 65);
    chosen = {
      next: diceSide,
      confidence: Math.round(conf),
      label: `phân tích xúc xắc (${diceInfo.reason})`,
      action: diceSide === arr[0] ? "THEO" : "BẺ",
      type: "dice"
    };
  }

  // ── Bước 4: Điều chỉnh theo độ chính xác gần đây ────────
  const recent20 = HISTORY.filter(h => h.checked).slice(-20);
  if (recent20.length >= 5) {
    const recentAcc = recent20.filter(h => h.dung).length / recent20.length;
    if (recentAcc < 0.42) {
      // Đang dự đoán tệ → giảm confidence, không thay đổi hướng
      chosen.confidence = Math.max(50, Math.round(chosen.confidence * 0.88));
      chosen.label += " [giảm tin cậy]";
    } else if (recentAcc > 0.62) {
      // Đang tốt → tăng nhẹ
      chosen.confidence = Math.min(85, chosen.confidence + 3);
    }
  }

  // ── Bước 5: Chống dao động — không lật khi không có căn cứ ─
  if (LAST_PREDICTION &&
      LAST_PREDICTION.side !== chosen.next &&
      chosen.type !== "early-break" &&
      chosen.type !== "bet") {
    const confDiff = chosen.confidence - LAST_PREDICTION.confidence;
    if (confDiff < 8 && PATTERN_STATE.wrongCount < 2) {
      chosen.next       = LAST_PREDICTION.side;
      chosen.confidence = LAST_PREDICTION.confidence;
      chosen.label     += " (giữ)";
    }
  }

  // ── Bước 6: Giới hạn confidence ─────────────────────────
  chosen.confidence = Math.max(50, Math.min(85, chosen.confidence));

  // ── Cập nhật pattern state ────────────────────────────────
  if (PATTERN_STATE.type !== chosen.type) {
    PATTERN_STATE = { type: chosen.type, startPhien: data[0].phien, length: 0, wrongCount: 0 };
  }
  PATTERN_STATE.length++;

  LAST_PREDICTION = { side: chosen.next, confidence: chosen.confidence, type: chosen.type };

  const du_doan  = chosen.next === "T" ? "tài" : "xỉu";
  const canh_bao = `🎯 ${chosen.label} | ${du_doan} (${chosen.confidence}%)`;

  return {
    du_doan,
    do_tin_cay: chosen.confidence,
    loai_cau:   chosen.label,
    hanh_dong:  chosen.action,
    canh_bao,
    dice_info: diceInfo,
    break_signals: breakSignals
  };
}

// ═══════════════════════════════════════════════════════════
//  KIỂM TRA & THỐNG KÊ LỊCH SỬ
// ═══════════════════════════════════════════════════════════
function verifyHistory(parsed) {
  const phienMap = {};
  parsed.forEach(p => { phienMap[p.phien] = p; });

  for (const h of HISTORY) {
    if (h.checked) continue;
    const real = phienMap[h.phien_thuc_hien];
    if (real !== undefined) {
      h.checked     = true;
      h.thuc_te     = real.ket_qua;
      h.xuc_xac_thuc = real.xuc_xac;
      h.dung        = h.du_doan === real.ket_qua;

      if (!h.dung) {
        CONSECUTIVE_ERRORS++;
        PATTERN_STATE.wrongCount++;
      } else {
        CONSECUTIVE_ERRORS = 0;
        PATTERN_STATE.wrongCount = Math.max(0, PATTERN_STATE.wrongCount - 1);
      }
    }
  }
  if (HISTORY.length > 200) HISTORY = HISTORY.slice(-200);
}

function calcAccuracy(n = 0) {
  const done = n > 0 ? HISTORY.filter(h => h.checked).slice(-n) : HISTORY.filter(h => h.checked);
  if (!done.length) return "chưa có";
  const correct = done.filter(h => h.dung).length;
  return ((correct / done.length) * 100).toFixed(1) + "%";
}

// ═══════════════════════════════════════════════════════════
//  MAIN UPDATE LOOP
// ═══════════════════════════════════════════════════════════
let lastPhien = null;

async function updateData() {
  try {
    const res      = await axios.get(API_URL, { timeout: 8000 });
    let sessions   = res.data?.list || [];
    if (!Array.isArray(sessions) || !sessions.length) return;

    sessions.sort((a, b) => b.id - a.id);
    sessions = sessions.slice(0, 50);

    const parsed = sessions.map(item => {
      const d  = item.dices || [1, 1, 1];
      const x1 = d[0] || 1, x2 = d[1] || 1, x3 = d[2] || 1;
      return {
        phien:    item.id,
        ket_qua:  item.resultTruyenThong === "TAI" ? "tài" : "xỉu",
        xuc_xac:  `${x1}-${x2}-${x3}`,
        total:    x1 + x2 + x3
      };
    });

    verifyHistory(parsed);
    const pred     = finalPredict(parsed);
    const latestP  = parsed[0].phien;

    // Ghi dự đoán mới khi có phiên mới
    if (latestP !== lastPhien) {
      lastPhien = latestP;
      HISTORY.push({
        phien_du_doan:    latestP,
        phien_thuc_hien:  latestP + 1,
        du_doan:          pred.du_doan,
        loai_cau:         pred.loai_cau,
        hanh_dong:        pred.hanh_dong,
        do_tin_cay:       pred.do_tin_cay,
        timestamp:        new Date().toISOString(),
        checked: false, thuc_te: null, xuc_xac_thuc: null, dung: null
      });
    }

    // KQ gần nhất đã kiểm chứng
    const lastVerified = [...HISTORY].reverse().find(h => h.checked);
    const ket_qua_gan_nhat = lastVerified ? {
      phien:   lastVerified.phien_thuc_hien,
      du_doan: lastVerified.du_doan,
      thuc_te: lastVerified.thuc_te,
      xuc_xac: lastVerified.xuc_xac_thuc,
      dung:    lastVerified.dung,
      icon:    lastVerified.dung ? "✅" : "❌"
    } : null;

    const s10 = parsed.slice(0, 10);
    CACHE = {
      phien:            latestP,
      ket_qua:          parsed[0].ket_qua,
      xuc_xac:          parsed[0].xuc_xac,
      du_doan:          pred.du_doan,
      do_tin_cay:       pred.do_tin_cay + "%",
      cau_dang_chay:    buildCauString(parsed, 15),
      loai_cau:         pred.loai_cau,
      hanh_dong:        pred.hanh_dong,
      canh_bao:         pred.canh_bao,
      ty_le_tai:        Math.round(s10.filter(i => i.ket_qua === "tài").length / s10.length * 100) + "%",
      ty_le_xiu:        Math.round(s10.filter(i => i.ket_qua === "xỉu").length / s10.length * 100) + "%",
      ket_qua_gan_nhat,
      do_chinh_xac:     calcAccuracy(),       // toàn bộ lịch sử
      recent_accuracy:  calcAccuracy(20),     // 20 phiên gần nhất
      consecutive_errors: CONSECUTIVE_ERRORS,
      dice_debug:       pred.dice_info,
      break_signals:    pred.break_signals,
      cap_nhat:         new Date().toLocaleTimeString("vi-VN")
    };

    console.log(
      `[${CACHE.cap_nhat}] #${latestP}` +
      ` | ${pred.loai_cau}` +
      ` | ${pred.hanh_dong} → ${pred.du_doan} (${pred.do_tin_cay}%)` +
      ` | Acc-All: ${CACHE.do_chinh_xac} | Acc-20: ${CACHE.recent_accuracy}` +
      (pred.break_signals ? ` | ⚠️ ${pred.break_signals.join(", ")}` : "")
    );
  } catch (err) {
    console.error("Lỗi API:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════
//  ENDPOINTS
// ═══════════════════════════════════════════════════════════
app.get("/",         (req, res) => res.json(CACHE));
app.get("/predict",  (req, res) => res.json({ status: "success", data: CACHE }));
app.get("/history",  (req, res) => {
  const checked = HISTORY.filter(h => h.checked).slice(-50).reverse();
  res.json({ status: "success", count: checked.length, data: checked });
});
app.get("/stats",    (req, res) => {
  const done    = HISTORY.filter(h => h.checked);
  const correct = done.filter(h => h.dung).length;
  const byType  = {};
  for (const h of done) {
    const t = h.loai_cau?.split(" ")[0] || "other";
    if (!byType[t]) byType[t] = { total: 0, correct: 0 };
    byType[t].total++;
    if (h.dung) byType[t].correct++;
  }
  res.json({
    status: "success",
    total: done.length,
    correct,
    accuracy_all:  calcAccuracy(),
    accuracy_20:   calcAccuracy(20),
    accuracy_50:   calcAccuracy(50),
    by_pattern: byType,
    consecutive_errors: CONSECUTIVE_ERRORS
  });
});
app.get("/algorithms", (req, res) => res.json({
  status: "success",
  version: "v5",
  method: "Multi-pattern ensemble: cầu 1-1 → khối → bệt thông minh → nghiêng → dice fallback. Tích hợp bẻ cầu sớm, điều chỉnh theo accuracy gần đây, chống dao động."
}));

// ─── Khởi động ───────────────────────────────────────────
updateData();
setInterval(updateData, 5000);
app.listen(PORT, () => {
  console.log(`\n🎲 Tài Xỉu AI v5 (Thuật toán nét, bền) — cổng ${PORT}\n`);
});