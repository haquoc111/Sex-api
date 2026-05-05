// server.js — Tài Xỉu AI v7 (VIP Pro: Nhận dạng cầu chuẩn + Theo/Bẻ thông minh)
const express = require("express");
const axios   = require("axios");
const cors    = require("cors");

const app = express();
app.use(cors());

const PORT    = process.env.PORT || 3000;
const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=62385f65eb49fcb34c72a7d6489ad91d";

// ════════════════════════════════════════════════════════════════
//  GLOBAL STATE
// ════════════════════════════════════════════════════════════════
let CACHE = {
  phien: "0", ket_qua: "đang tải", xuc_xac: "0-0-0",
  du_doan: "đang phân tích", do_tin_cay: "0%",
  cau_dang_chay: "-", loai_cau: "đang phân tích",
  hanh_dong: "-", canh_bao: "đang tải",
  ty_le_tai: "0%", ty_le_xiu: "0%",
  ket_qua_gan_nhat: null, do_chinh_xac: "chưa có",
  recent_accuracy: "chưa có", cap_nhat: ""
};

let HISTORY          = [];   // lịch sử dự đoán đã ghi
let LAST_PREDICTION  = null; // { side, confidence, type, cycle_id }
let PATTERN_STATS    = {};   // { type: { total, correct, streak_correct, streak_wrong } }
let CONSECUTIVE_ERRORS = 0;
let CURRENT_CYCLE    = null; // cầu đang theo dõi { id, type, period, startIdx, errCount, totalFollowed }
let CYCLE_ID         = 0;    // unique id cho mỗi cầu phát hiện

// ════════════════════════════════════════════════════════════════
//  TIỆN ÍCH
// ════════════════════════════════════════════════════════════════
const opp   = s => s === "T" ? "X" : "T";
const toTX  = item => item.ket_qua === "tài" ? "T" : "X";
const toArr = data => data.map(toTX);

// ════════════════════════════════════════════════════════════════
//  PHÂN TÍCH XÚC XẮC NÂNG CAO
// ════════════════════════════════════════════════════════════════
function diceAnalysis(data) {
  const totals = data.slice(0, 25).map(i => i.total);
  const n = totals.length;
  if (n < 4) return { bias: 0, volatile: false, diceConf: 50 };

  const last5 = totals.slice(0, 5);
  const avg5  = last5.reduce((a, b) => a + b, 0) / 5;
  const var5  = last5.reduce((s, v) => s + (v - avg5) ** 2, 0) / 5;
  const stdDev = Math.sqrt(var5);

  // Xu hướng tuyến tính (arr[0]=mới nhất)
  const yMean = totals.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - (n - 1) / 2) * (totals[i] - yMean); den += (i - (n - 1) / 2) ** 2; }
  const slope = den ? num / den : 0;
  const trendBias = -slope * 3.0;

  // Hồi quy về trung bình
  let revBias = 0;
  if (avg5 > 14)    revBias = -20;
  else if (avg5 > 13)   revBias = -12;
  else if (avg5 > 12.5) revBias = -6;
  else if (avg5 < 7)    revBias = 20;
  else if (avg5 < 8)    revBias = 12;
  else if (avg5 < 8.5)  revBias = 6;

  // Điểm cuối
  const lt = totals[0];
  let lastBias = 0;
  if      (lt >= 16) lastBias = -18;
  else if (lt >= 14) lastBias = -10;
  else if (lt >= 13) lastBias = -4;
  else if (lt <= 5)  lastBias = 18;
  else if (lt <= 7)  lastBias = 10;
  else if (lt <= 8)  lastBias = 4;

  const bias     = trendBias + revBias + lastBias;
  const volatile = stdDev > 2.8;
  let diceConf   = 50 + Math.min(Math.abs(bias) * 1.1, 32);
  if (volatile) diceConf = Math.max(46, diceConf - 12);

  return { bias, volatile, avg5: avg5.toFixed(1), stdDev: stdDev.toFixed(2), diceConf: Math.round(diceConf) };
}

// ════════════════════════════════════════════════════════════════
//  NHẬN DẠNG CẦU — phân tích chi tiết từng loại
//  Trả về mảng các ứng viên cầu với điểm ưu tiên
// ════════════════════════════════════════════════════════════════

/**
 * Xác định chuỗi BỆTH (arr[0] mới nhất):
 * Đếm xem arr[0] lặp liên tiếp bao nhiêu phần tử.
 */
function detectStreak(arr) {
  if (!arr.length) return { val: null, len: 0 };
  const v = arr[0];
  let l = 1;
  for (let i = 1; i < arr.length && arr[i] === v; i++) l++;
  return { val: v, len: l };
}

/**
 * Nhận dạng cầu theo chu kỳ p từ mảng arr (arr[0]=mới nhất).
 * Cần ít nhất 2 chu kỳ đầy đủ để xác nhận.
 * Trả về: { period, hits, totalContig, next, strength, label } hoặc null
 */
function detectPeriod(arr, p) {
  const len = arr.length;
  if (len < p * 2) return null;          // cần ít nhất 2 chu kỳ

  // Đếm số vị trí liên tiếp từ đầu mà arr[i] === arr[i+p]
  let contig = 0;
  for (let i = 0; i + p < len; i++) {
    if (arr[i] === arr[i + p]) contig++;
    else break;
  }
  // Cần ít nhất 2 chu kỳ liên tục -> contig >= 2*p-1? Không: contig >= p đủ cho 2 chu kỳ (p cặp)
  // Thực tế: contig >= p*2 nghĩa là 3 chu kỳ liên tục — bắt cầu nhanh hơn thì dùng >= p*1
  // Ta dùng >= p (bắt cầu nhanh: 2 chu kỳ là đủ)
  const minContig = p; // = 1 chu kỳ khớp (đủ để xác nhận 2 chu kỳ tổng)
  if (contig < minContig) return null;

  // Lấy đoạn p phần tử mới nhất làm "template" của một chu kỳ
  // Phần tử tiếp theo (phiên kế) = arr[p-1] (theo logic đảo ngược)
  const next     = arr[p - 1];
  const strength = contig * (1 + p * 0.15); // chu kỳ dài có thêm điểm

  return { period: p, hits: contig, next, strength };
}

/**
 * Tạo nhãn đẹp cho từng loại cầu
 */
function buildCycleLabel(period, arr) {
  // Lấy p phần tử mới nhất làm mẫu để đặt tên
  const sample = arr.slice(0, period).reverse(); // đảo lại: [cũ → mới]
  const raw    = sample.join(""); // vd: "TX", "TTX"

  // Một số tên đặc biệt
  const special = {
    "T":    "bệt tài",
    "X":    "bệt xỉu",
    "TX":   "cầu 1-1 (T→X)",
    "XT":   "cầu 1-1 (X→T)",
    "TTX":  "cầu 2-1 (bẻ xỉu)",
    "TXX":  "cầu 1-2 (bẻ tài)",
    "XXT":  "cầu 2-1 (bẻ tài)",
    "XTT":  "cầu 1-2 (bẻ xỉu)",
    "TTTX": "cầu 3-1",
    "TXXX": "cầu 1-3",
    "XXXT": "cầu 3-1 (xỉu)",
    "XTTT": "cầu 1-3 (xỉu→tài)",
    "TTT":  "bệt 3 tài",
    "XXX":  "bệt 3 xỉu",
    "TTTT": "bệt 4 tài",
    "XXXX": "bệt 4 xỉu",
    "TTTTT":"bệt 5 tài",
    "XXXXX":"bệt 5 xỉu",
    "TXTX": "cầu 1-1-1-1",
    "XTXT": "cầu 1-1-1-1 (x)",
    "TTXX": "cầu 2-2",
    "XXTT": "cầu 2-2 (x)",
    "TTTXXX":"cầu 3-3",
    "XXXTTT":"cầu 3-3 (x)",
    "TTTTXXXX":"cầu 4-4",
    "TTTTTXXXXX":"cầu 5-5",
    "TXTXT":"cầu 3-1-3 (mẫu TX)",
    "XTXXT":"cầu 3-1-3 (mẫu XT)",
    "TXTTXT":"cầu 4-1",
  };
  return special[raw] || `cầu ${period}-cyc [${raw}]`;
}

/**
 * Hàm phát hiện tất cả cầu có thể (period 1..10)
 * Trả về danh sách sorted theo strength DESC
 */
function detectAllCycles(arr) {
  const candidates = [];
  for (let p = 1; p <= 10; p++) {
    const r = detectPeriod(arr, p);
    if (r) {
      r.label = buildCycleLabel(p, arr);
      candidates.push(r);
    }
  }
  // Sort: strength cao trước, cùng strength thì period nhỏ hơn (bệt ngắn) ưu tiên hơn
  candidates.sort((a, b) => b.strength - a.strength || a.period - b.period);
  return candidates;
}

// ════════════════════════════════════════════════════════════════
//  CƠ CHẾ THEO VÀ BẺ CẦU — trọng tâm thuật toán
//  CURRENT_CYCLE lưu trạng thái cầu đang theo:
//    { cycleId, period, label, next, errCount, totalFollowed, forceBreak }
//  Logic:
//    - Khi phát hiện cầu mới (khác cycle cũ) -> cập nhật CURRENT_CYCLE
//    - errCount: số lần dự đoán sai liên tiếp TRONG cầu này
//    - Nếu errCount >= breakThreshold -> BẺ cầu (đổi chiều)
//    - Nếu cầu không còn khớp pattern_stats -> BẺ sớm
// ════════════════════════════════════════════════════════════════

function decideCycleAction(best, dice) {
  const p = best.period;
  const hits = best.hits;
  // Số lần cần để "xác nhận" cầu ổn định
  const stableThreshold = p >= 4 ? p * 2 : p * 3;
  const isStable = hits >= stableThreshold;

  // Độ tin cậy cơ bản
  let baseConf = 58 + Math.min(hits * 1.0, 28);

  // Tăng nếu dice cùng chiều
  const diceDir = dice.bias >= 0 ? "T" : "X";
  if (diceDir === best.next) baseConf += 7;
  else if (Math.abs(dice.bias) > 14) baseConf -= 7;

  // Nếu có thống kê loại cầu này
  const stats = PATTERN_STATS[best.label];
  if (stats && stats.total >= 4) {
    const acc = stats.correct / stats.total;
    if (acc >= 0.70) baseConf += 8;
    else if (acc >= 0.60) baseConf += 4;
    else if (acc < 0.40) baseConf -= 10;
  }

  baseConf = Math.max(55, Math.min(91, Math.round(baseConf)));

  // Quyết định THEO hay BẺ
  let action = "THEO";
  let predictedNext = best.next;

  // BẺ khi: cầu chưa ổn định + dice mạnh ngược chiều + volatile
  if (!isStable && dice.volatile && Math.abs(dice.bias) > 16 && diceDir !== best.next) {
    action = "BẺ";
    predictedNext = opp(best.next);
    baseConf = Math.max(57, baseConf - 5);
  }

  // BẺ khi: cầu ngắn (p=1 bệt) dài >= 7 -> khả năng gãy cao
  if (p === 1 && hits >= 7) {
    action = "BẺ";
    predictedNext = opp(best.next);
    baseConf = Math.max(60, baseConf + 3);
  }
  // BẺ khi: cầu 1-1 dài >= 10
  if (p === 2 && hits >= 10) {
    action = "BẺ";
    predictedNext = opp(best.next);
    baseConf = Math.max(60, baseConf);
  }

  // Nếu CURRENT_CYCLE đang theo dõi cùng cầu (period + label khớp) -> xét errCount
  if (CURRENT_CYCLE && CURRENT_CYCLE.period === p && CURRENT_CYCLE.label === best.label) {
    if (CURRENT_CYCLE.errCount >= 2) {
      // Cầu gãy -> BẺ
      action = "BẺ";
      predictedNext = opp(best.next);
      baseConf = Math.max(58, baseConf - 3);
    } else if (CURRENT_CYCLE.errCount === 1 && !isStable) {
      // Cầu bắt đầu lung lay -> thận trọng
      action = "BẺ?";
      baseConf = Math.max(55, baseConf - 5);
    }
  }

  return { action, next: predictedNext, confidence: baseConf };
}

// ════════════════════════════════════════════════════════════════
//  DỰ ĐOÁN TỔNG HỢP (VIP v7)
// ════════════════════════════════════════════════════════════════
function finalPredict(data) {
  if (data.length < 4) {
    return {
      du_doan: "tài", do_tin_cay: 50,
      loai_cau: "chưa đủ dữ liệu", hanh_dong: "-",
      canh_bao: "⏳ Đang thu thập dữ liệu...",
      streak_info: null, cycle_candidates: []
    };
  }

  const arr  = toArr(data);
  const dice = diceAnalysis(data);

  // 1. Phát hiện tất cả cầu
  const allCycles = detectAllCycles(arr);

  // 2. Streak hiện tại
  const streak = detectStreak(arr);

  let chosen = {
    next: "T", confidence: 52, label: "dự phòng (dice)", action: "THEO", type: "fallback"
  };

  if (allCycles.length > 0) {
    // Lấy cầu tốt nhất
    const best = allCycles[0];

    // Cập nhật CURRENT_CYCLE
    if (!CURRENT_CYCLE || CURRENT_CYCLE.period !== best.period || CURRENT_CYCLE.label !== best.label) {
      // Phát hiện cầu mới
      CYCLE_ID++;
      CURRENT_CYCLE = {
        cycleId: CYCLE_ID,
        period: best.period,
        label: best.label,
        errCount: 0,
        totalFollowed: 0
      };
    }

    const decision = decideCycleAction(best, dice);

    chosen = {
      next: decision.next,
      confidence: decision.confidence,
      label: `${best.label} (khớp:${best.hits})`,
      action: decision.action,
      type: best.label
    };
  } else {
    // Không có cầu rõ ràng -> dùng streak + dice
    const diceDir = dice.bias >= 0 ? "T" : "X";

    if (streak.len >= 6) {
      // Bệt cực dài -> khả năng gãy cao
      chosen = {
        next: opp(streak.val), confidence: 70,
        label: `bệt ${streak.len} (bẻ mạnh)`, action: "BẺ", type: "streak-long"
      };
    } else if (streak.len >= 4) {
      // Bệt dài vừa -> theo nếu dice cùng chiều, bẻ nếu dice ngược
      if (diceDir !== streak.val && Math.abs(dice.bias) > 10) {
        chosen = { next: opp(streak.val), confidence: 65, label: `bệt ${streak.len} (bẻ dice)`, action: "BẺ", type: "streak-med" };
      } else {
        chosen = { next: streak.val, confidence: 63, label: `bệt ${streak.len} (theo)`, action: "THEO", type: "streak-med" };
      }
    } else if (streak.len >= 2) {
      chosen = {
        next: streak.val, confidence: 56,
        label: `bệt ngắn ${streak.len} (theo)`, action: "THEO", type: "streak-short"
      };
    } else {
      // Pure dice
      const conf = Math.min(62, 46 + Math.abs(dice.bias) * 0.5);
      chosen = {
        next: diceDir, confidence: Math.round(conf),
        label: "phân tích xúc xắc", action: diceDir === arr[0] ? "THEO" : "BẺ", type: "dice-only"
      };
    }
  }

  // 3. Cập nhật CURRENT_CYCLE errCount từ LAST_PREDICTION
  if (LAST_PREDICTION && CURRENT_CYCLE && LAST_PREDICTION.cycle_id === CURRENT_CYCLE.cycleId) {
    CURRENT_CYCLE.totalFollowed++;
  }

  // 4. Chống lật dự đoán liên tục (anti-flip)
  if (LAST_PREDICTION &&
      LAST_PREDICTION.side !== chosen.next &&
      !["BẺ", "BẺ?"].includes(chosen.action) &&
      chosen.confidence - LAST_PREDICTION.confidence < 8 &&
      LAST_PREDICTION.confidence >= 62) {
    chosen.next = LAST_PREDICTION.side;
    chosen.confidence = Math.max(53, LAST_PREDICTION.confidence - 3);
    chosen.label += " (ổn định)";
  }

  // 5. Điều chỉnh confidence bởi CONSECUTIVE_ERRORS tổng thể
  if (CONSECUTIVE_ERRORS >= 3) {
    chosen.confidence = Math.max(52, chosen.confidence - 6);
    chosen.label += " ⚠️ thận trọng";
  }

  // 6. Lưu LAST_PREDICTION
  LAST_PREDICTION = {
    side: chosen.next, confidence: chosen.confidence,
    type: chosen.type, cycle_id: CURRENT_CYCLE?.cycleId || 0
  };

  const du_doan = chosen.next === "T" ? "tài" : "xỉu";
  const icon    = chosen.action === "BẺ" ? "🔄" : chosen.action === "BẺ?" ? "⚠️" : "✅";

  return {
    du_doan,
    do_tin_cay: chosen.confidence,
    loai_cau: chosen.label,
    hanh_dong: chosen.action,
    canh_bao: `${icon} [${chosen.action}] ${chosen.label} → ${du_doan} (${chosen.confidence}%)`,
    dice_info: dice,
    cycle_candidates: allCycles.slice(0, 5).map(c => ({ label: c.label, hits: c.hits, period: c.period, next: c.next === "T" ? "tài" : "xỉu" })),
    streak_info: { val: arr[0] === "T" ? "tài" : "xỉu", len: detectStreak(arr).len }
  };
}

// ════════════════════════════════════════════════════════════════
//  XÁC MINH LỊCH SỬ & CẬP NHẬT PATTERN STATS + CURRENT_CYCLE
// ════════════════════════════════════════════════════════════════
function verifyHistory(parsed) {
  const phienMap = {};
  parsed.forEach(p => { phienMap[p.phien] = p; });

  for (const h of HISTORY) {
    if (h.checked) continue;
    const real = phienMap[h.phien_thuc_hien];
    if (!real) continue;

    h.checked    = true;
    h.thuc_te    = real.ket_qua;
    h.xuc_thuc   = real.xuc_xac;
    h.dung       = h.du_doan === real.ket_qua;

    // Pattern stats
    const type = h.pattern_type || "other";
    if (!PATTERN_STATS[type]) PATTERN_STATS[type] = { total: 0, correct: 0 };
    PATTERN_STATS[type].total++;
    if (h.dung) { PATTERN_STATS[type].correct++; CONSECUTIVE_ERRORS = 0; }
    else CONSECUTIVE_ERRORS++;

    // Cập nhật errCount cho CURRENT_CYCLE nếu cycle_id khớp
    if (CURRENT_CYCLE && h.cycle_id === CURRENT_CYCLE.cycleId) {
      if (!h.dung) CURRENT_CYCLE.errCount++;
      else         CURRENT_CYCLE.errCount = 0; // reset khi đúng lại
    }
  }
  if (HISTORY.length > 500) HISTORY = HISTORY.slice(-500);
}

function calcAccuracy(n = 0) {
  const done = HISTORY.filter(h => h.checked);
  const slice = n > 0 ? done.slice(-n) : done;
  if (!slice.length) return "chưa có";
  const correct = slice.filter(h => h.dung).length;
  return ((correct / slice.length) * 100).toFixed(1) + "%";
}

// ════════════════════════════════════════════════════════════════
//  MAIN UPDATE LOOP
// ════════════════════════════════════════════════════════════════
let lastPhien = null;

async function updateData() {
  try {
    const res = await axios.get(API_URL, { timeout: 8000 });
    let sessions = res.data?.list || [];
    if (!Array.isArray(sessions) || !sessions.length) return;

    sessions.sort((a, b) => b.id - a.id);
    sessions = sessions.slice(0, 80); // lấy nhiều hơn để cầu dài nhận dạng chính xác

    const parsed = sessions.map(item => {
      const d = item.dices || [1, 1, 1];
      const x1 = d[0] || 1, x2 = d[1] || 1, x3 = d[2] || 1;
      return {
        phien:    item.id,
        ket_qua:  item.resultTruyenThong === "TAI" ? "tài" : "xỉu",
        xuc_xac:  `${x1}-${x2}-${x3}`,
        total:    x1 + x2 + x3
      };
    });

    verifyHistory(parsed);
    const pred = finalPredict(parsed);
    const arr  = toArr(parsed);

    const latestP = parsed[0].phien;
    if (latestP !== lastPhien) {
      lastPhien = latestP;
      HISTORY.push({
        phien_du_doan:    latestP,
        phien_thuc_hien:  latestP + 1,
        du_doan:          pred.du_doan,
        pattern_type:     pred.loai_cau?.split("(")[0].trim() || "other",
        loai_cau:         pred.loai_cau,
        hanh_dong:        pred.hanh_dong,
        do_tin_cay:       pred.do_tin_cay,
        cycle_id:         CURRENT_CYCLE?.cycleId || 0,
        timestamp:        new Date().toISOString(),
        checked: false, thuc_te: null, xuc_thuc: null, dung: null
      });
    }

    // Kết quả gần nhất đã kiểm chứng
    const lastV = [...HISTORY].reverse().find(h => h.checked);
    const ket_qua_gan_nhat = lastV ? {
      phien:    lastV.phien_thuc_hien,
      du_doan:  lastV.du_doan,
      thuc_te:  lastV.thuc_te,
      xuc_xac:  lastV.xuc_thuc,
      hanh_dong: lastV.hanh_dong,
      dung:     lastV.dung,
      icon:     lastV.dung ? "✅" : "❌"
    } : null;

    const s10 = parsed.slice(0, 10);
    CACHE = {
      phien:       latestP,
      ket_qua:     parsed[0].ket_qua,
      xuc_xac:     parsed[0].xuc_xac,
      du_doan:     pred.du_doan,
      do_tin_cay:  pred.do_tin_cay + "%",
      cau_dang_chay: arr.slice(0, 20).join(""),
      loai_cau:    pred.loai_cau,
      hanh_dong:   pred.hanh_dong,
      canh_bao:    pred.canh_bao,
      ty_le_tai:   Math.round(s10.filter(i => i.ket_qua === "tài").length / 10 * 100) + "%",
      ty_le_xiu:   Math.round(s10.filter(i => i.ket_qua === "xỉu").length / 10 * 100) + "%",
      ket_qua_gan_nhat,
      do_chinh_xac:      calcAccuracy(),
      recent_accuracy:   calcAccuracy(20),
      accuracy_50:       calcAccuracy(50),
      consecutive_errors: CONSECUTIVE_ERRORS,
      cycle_candidates:  pred.cycle_candidates,
      streak_info:       pred.streak_info,
      current_cycle:     CURRENT_CYCLE ? {
        id:     CURRENT_CYCLE.cycleId,
        label:  CURRENT_CYCLE.label,
        period: CURRENT_CYCLE.period,
        errCount: CURRENT_CYCLE.errCount,
        totalFollowed: CURRENT_CYCLE.totalFollowed
      } : null,
      dice_debug:    pred.dice_info,
      pattern_stats: PATTERN_STATS,
      cap_nhat:      new Date().toLocaleTimeString("vi-VN")
    };

    console.log(
      `[${CACHE.cap_nhat}] #${latestP} | ${pred.loai_cau} | ${pred.hanh_dong} → ${pred.du_doan}` +
      ` (${pred.do_tin_cay}%) | Acc: ${CACHE.do_chinh_xac} | Acc20: ${CACHE.recent_accuracy}` +
      ` | ErrStreak: ${CONSECUTIVE_ERRORS}`
    );
  } catch (err) {
    console.error("Lỗi API:", err.message);
  }
}

// ════════════════════════════════════════════════════════════════
//  ENDPOINTS
// ════════════════════════════════════════════════════════════════
app.get("/",        (req, res) => res.json(CACHE));
app.get("/predict", (req, res) => res.json({ status: "success", data: CACHE }));

app.get("/history", (req, res) => {
  const checked = HISTORY.filter(h => h.checked).slice(-50).reverse();
  res.json({ status: "success", count: checked.length, data: checked });
});

app.get("/stats", (req, res) => {
  const done    = HISTORY.filter(h => h.checked);
  const correct = done.filter(h => h.dung).length;
  res.json({
    status: "success",
    total:           done.length,
    correct,
    accuracy_all:    calcAccuracy(),
    accuracy_20:     calcAccuracy(20),
    accuracy_50:     calcAccuracy(50),
    by_pattern:      PATTERN_STATS,
    consecutive_errors: CONSECUTIVE_ERRORS,
    current_cycle:   CURRENT_CYCLE
  });
});

app.get("/cycles", (req, res) => {
  // Trả về top ứng viên cầu hiện tại (debug)
  res.json({
    status: "success",
    current_cycle: CURRENT_CYCLE,
    cau_dang_chay: CACHE.cau_dang_chay,
    cycle_candidates: CACHE.cycle_candidates
  });
});

app.get("/algorithms", (req, res) => res.json({
  status:  "success",
  version: "v7-VIP",
  method:  [
    "1. Nhận dạng toàn bộ cầu chu kỳ (bệt/1-1/1-2/2-1/2-2/3-1/1-3/3-3/4-4/5-5/3-1-3...) từ lịch sử 80 phiên",
    "2. Bắt cầu nhanh (chỉ cần 2 chu kỳ liên tiếp xác nhận)",
    "3. Theo cầu: ưu tiên cầu mạnh nhất, tăng confidence khi dice đồng thuận",
    "4. Bẻ cầu thông minh: tự động bẻ khi bệt quá dài (>=7), cầu 1-1 quá dài (>=10), dice cực mạnh ngược chiều, hoặc 2 lần sai liên tiếp trong cầu",
    "5. Anti-flip: không lật dự đoán liên tục khi không đủ tự tin",
    "6. CURRENT_CYCLE tracker: theo dõi errCount từng cầu riêng biệt",
    "7. Pattern stats: điều chỉnh confidence theo hiệu suất lịch sử từng loại cầu"
  ]
}));

// ─── KHỞI ĐỘNG ─────────────────────────────────────────────────
updateData();
setInterval(updateData, 5000);
app.listen(PORT, () => {
  console.log(`\n🎲 Tài Xỉu AI v7 (VIP Pro Pattern Engine) — cổng ${PORT}\n`);
});
