// server.js — Tài Xỉu AI v6 (Pro Pattern Engine: bắt mọi cầu, theo/bẻ thông minh)
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
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

let HISTORY = [];               // lịch sử dự đoán
let LAST_PREDICTION = null;     // { side, confidence, pattern_type, cycle }
let PATTERN_STATS = {};         // thống kê hiệu suất từng loại cầu { type: { total, correct } }
let CONSECUTIVE_ERRORS = 0;

// ═══════════════════════════════════════════════════════════
//  TIỆN ÍCH CHUYỂN ĐỔI
// ═══════════════════════════════════════════════════════════
const opp = (side) => side === "T" ? "X" : "T";
const toTX = (item) => item.ket_qua === "tài" ? "T" : "X";
const toArr = (data) => data.map(toTX);

// ═══════════════════════════════════════════════════════════
//  PHÂN TÍCH XÚC XẮC NÂNG CAO
// ═══════════════════════════════════════════════════════════
function diceAnalysisEnhanced(data) {
  const totals = data.slice(0, 20).map(i => i.total);
  const n = totals.length;
  if (n < 4) return { bias: 0, volatile: false, confidence: 0, reason: "ít dữ liệu" };

  const last5 = totals.slice(0, 5);
  const avg5 = last5.reduce((a, b) => a + b, 0) / 5;
  const var5 = last5.reduce((s, v) => s + (v - avg5) ** 2, 0) / 5;
  const stdDev = Math.sqrt(var5);

  // Xu hướng (slope) – dương = đang tăng dần về giá trị (cũ có index lớn)
  const xMean = (n - 1) / 2;
  const yMean = totals.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (totals[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den ? num / den : 0;
  // slope âm → đang tăng, dương → đang giảm (vì mảng[0] là mới nhất)
  const trendBias = -slope * 3.5;

  // Hồi quy về trung bình
  let reversionBias = 0;
  if (avg5 > 13.5) reversionBias = -18;
  else if (avg5 > 12.5) reversionBias = -10;
  else if (avg5 < 8.5) reversionBias = 18;
  else if (avg5 < 9.5) reversionBias = 10;

  // Tổng cuối cùng
  const lastTotal = totals[0];
  let lastBias = 0;
  if (lastTotal >= 15) lastBias = -14;
  else if (lastTotal >= 13) lastBias = -6;
  else if (lastTotal <= 6) lastBias = 14;
  else if (lastTotal <= 8) lastBias = 6;

  // Điểm mất cân bằng xúc xắc
  const bias = trendBias + reversionBias + lastBias;
  const volatile = stdDev > 3.0;

  // Độ tin cậy của dice (0-100)
  let diceConf = 50 + Math.min(Math.abs(bias) * 1.2, 35);
  if (volatile) diceConf = Math.max(45, diceConf - 15);

  return {
    bias,
    volatile,
    avg5: avg5.toFixed(1),
    stdDev: stdDev.toFixed(2),
    slope: slope.toFixed(3),
    diceConf: Math.round(diceConf),
    reason: `avg5=${avg5.toFixed(1)} std=${stdDev.toFixed(2)} slope=${slope.toFixed(2)}`
  };
}

// ═══════════════════════════════════════════════════════════
//  MÁY DÒ CHU KỲ TỔNG QUÁT (phát hiện mọi cầu)
// ═══════════════════════════════════════════════════════════
function detectCyclePattern(arr) {
  const len = arr.length;
  if (len < 6) return null;

  let best = null; // { period, startIdx, strength, next, hits, patternDesc }

  // Duyệt chu kỳ từ 1 (bệt) đến 12
  for (let p = 1; p <= 12; p++) {
    if (p > len) break;
    // Kiểm tra chu kỳ p trên toàn bộ mảng (càng dài càng tốt)
    let matchCount = 0;
    let firstMismatch = -1;
    for (let i = 0; i + p < len; i++) {
      if (arr[i] === arr[i + p]) {
        matchCount++;
      } else {
        if (firstMismatch === -1) firstMismatch = i;
        break; // chỉ tính chuỗi liên tục từ đầu
      }
    }
    // Nếu không có lỗi nào trong ít nhất 2p phần tử thì ghi nhận
    const requiredLength = p * 3; // cần ít nhất 3 chu kỳ để xác nhận
    if (matchCount >= requiredLength) {
      const strength = matchCount * (1 + p / 10); // chu kỳ dài được ưu tiên hơn
      // Dự đoán ký tự tiếp theo dựa trên vị trí cuối cùng trong chu kỳ
      const posInCycle = (len) % p; // vị trí sẽ xuất hiện tiếp theo (0 = cùng với arr[0]?)
      // arr[0] là mới nhất, nó ứng với vị trí (len-1) nếu đếm từ cũ đến mới. Phức tạp, ta dùng cách:
      // Tìm index của phần tử sẽ xuất hiện tiếp: vì arr[0] là mới nhất, arr[1] cũ hơn...
      // Giả sử chu kỳ bắt đầu từ arr[0]? Ta cần biết chu kỳ thực sự bắt đầu từ đâu.
      // Đơn giản: lấy đoạn cuối dài p, xác định thứ tự xuất hiện.
      // Nếu arr[i] == arr[i+p] với mọi i từ 0 đến hết đoạn khớp, tức arr[0] lặp lại sau p bước.
      // Vậy phần tử tiếp theo sẽ là arr[0] (vì sau p bước nó quay lại chính nó) – nhưng thực tế arr[0] là phiên hiện tại, phiên tiếp theo là arr[-1]?
      // Ta cần dự đoán cho phiên tiếp theo (sắp xảy ra). Nếu chu kỳ p, thì phiên tiếp theo sẽ giống với phiên cách đó p bước về trước: arr[p]? Không, cần cẩn thận.
      // Mảng arr sắp xếp: arr[0] = phiên mới nhất (id lớn nhất), arr[1] = phiên trước đó, ...
      // Nếu phát hiện chu kỳ p: arr[i] == arr[i+p] với mọi i trong vùng khớp, thì xu hướng hiện tại là lặp.
      // Để dự đoán cho phiên sắp tới (phiên mới hơn arr[0]), ta cần xem arr[?] sẽ bằng arr[0-p]? Không có arr[-1].
      // Ta nhìn vào mẫu: arr[0] là điểm cuối của một chu kỳ. Nếu chu kỳ đúng, thì phần tử tiếp theo sẽ là phần tử cách arr[0] một bước trong chu kỳ. 
      // Ta cần xác định vị trí trong chu kỳ của arr[0]. Nếu arr[0] == arr[p] (tức sau p bước lặp), vậy arr[0] thuộc vị trí (p)? 
      // Dễ nhất: tìm vị trí bắt đầu của một chu kỳ hoàn chỉnh gần nhất. Giả sử chu kỳ bắt đầu từ arr[start] nào đó, nhưng ta không biết. Dùng đoạn cuối: 
      // Xây dựng một mảng pattern bằng cách lấy arr[0], arr[1], ..., arr[p-1] (p phần tử cuối). Đây chính là một chu kỳ mẫu (vì arr[0] đến arr[p-1] khớp với arr[p] đến arr[2p-1] nếu matchCount >=2p). Khi đó, phần tử tiếp theo sẽ là phần tử đầu tiên của chu kỳ mẫu đó, tức arr[p-1]? Hơi lộn xộn.
      // Thực nghiệm: Nếu p=2 (1-1), mẫu: arr[0]='X', arr[1]='T', thì arr[0]==arr[2]? Có (X, T, X). Vậy chu kỳ là X,T. Phần tử tiếp theo sẽ là X (giống arr[0])? Hay T? Để xen kẽ, sau arr[0]=X cần T. Ta cần dựa vào arr[1] chứ? Nếu arr[0] là X, arr[1] là T, và arr[2]=X, thì thứ tự là ...X, T, X (arr[2] cũ hơn, arr[1] cũ hơn, arr[0] mới). Vậy mới nhất là X, trước đó T, trước đó X. Chu kỳ 1-1 đúng. Dự đoán tiếp theo phải là T (đối lập). Có nghĩa tiếp theo = arr[1] (phần tử cách 1 bước). Tổng quát: nếu chu kỳ p, phần tử tiếp theo = arr[p-1]? Với p=2: arr[1] là T, đúng. Với p=1 (bệt): arr[0] = X, arr[0] lặp, dự đoán tiếp = X = arr[0] (p-1=0). Với p=3 (mẫu T, X, X): arr[0]=X, arr[1]=X, arr[2]=T. Thứ tự từ cũ đến mới: arr[2]=T, arr[1]=X, arr[0]=X. Chu kỳ T,X,X. Phần tử tiếp theo nên là T = arr[2]. p-1=2, arr[2]=T -> đúng. Vậy quy tắc: next = arr[p-1] nếu ta coi chu kỳ bắt đầu từ arr[p-1] (cũ nhất trong p phần tử cuối). Tuy nhiên cần kiểm tra: nếu matchCount không phủ toàn bộ p phần tử cuối? matchCount >= p*3 đảm bảo khớp ít nhất 3p phần tử, nên p phần tử cuối chắc chắn nằm trong vùng khớp. Do đó áp dụng được.
      // Để an toàn, ta xác định: vì arr[0] khớp với arr[p], arr[1] khớp arr[p+1]..., nên đoạn arr[0..p-1] chính là một đơn vị chu kỳ (đảo ngược). Phần tử tiếp theo sẽ là phần tử đầu tiên của chu kỳ đó, tức arr[p-1] (phần tử cũ nhất trong nhóm p cuối).
      const next = arr[p - 1];
      const desc = p === 1 ? "bệt" : p === 2 ? "1-1" : `${p}-cyc`; // có thể đặt tên đẹp hơn
      if (!best || strength > best.strength) {
        best = {
          period: p,
          strength,
          next,
          hits: matchCount,
          patternDesc: desc,
          firstMismatch
        };
      }
    }
  }

  return best;
}

// ═══════════════════════════════════════════════════════════
//  DỰ ĐOÁN TỔNG HỢP (THEO + BẺ + DICE)
// ═══════════════════════════════════════════════════════════
function finalPredict(data) {
  if (data.length < 4) {
    return {
      du_doan: "tài", do_tin_cay: 50,
      loai_cau: "chưa đủ dữ liệu", hanh_dong: "-",
      canh_bao: "⏳ Đang thu thập dữ liệu..."
    };
  }

  const arr = toArr(data);
  const dice = diceAnalysisEnhanced(data);
  const cycle = detectCyclePattern(arr);

  let chosen = { next: "T", confidence: 50, label: "mặc định", action: "THEO", type: "none" };

  if (cycle) {
    // Có cầu chu kỳ rõ ràng
    const baseConf = 60 + Math.min(cycle.strength * 0.8, 25);
    // điều chỉnh bởi dice: nếu dice cùng hướng -> tăng, ngược hướng -> giảm
    const diceDirection = dice.bias >= 0 ? "T" : "X";
    let adjust = 0;
    if (diceDirection === cycle.next) adjust = 8;
    else if (Math.abs(dice.bias) > 12) adjust = -8; // dice mạnh ngược chiều -> giảm tin

    let confidence = Math.round(baseConf + adjust);
    confidence = Math.max(55, Math.min(88, confidence));

    // Quyết định THEO hay BẺ dựa trên độ ổn định của chu kỳ và dice
    const cycleStable = cycle.hits >= cycle.period * 5; // ít nhất 5 lần lặp
    const diceVolatile = dice.volatile;
    let action = "THEO";
    if (!cycleStable && diceVolatile) {
      action = "BẺ";
      confidence = Math.max(60, confidence - 7);
    } else if (cycle.period > 1 && dice.bias * (cycle.next === "T" ? 1 : -1) < -15) {
      // Dice cực đoan ngược chu kỳ -> bẻ
      action = "BẺ";
      cycle.next = opp(cycle.next); // đảo hướng
    }

    chosen = {
      next: cycle.next,
      confidence,
      label: `cầu ${cycle.patternDesc} (dài ${cycle.hits})`,
      action,
      type: cycle.patternDesc
    };
  } else {
    // Không có chu kỳ rõ -> dùng dice kết hợp streak ngắn
    const streak = (() => {
      if (!arr.length) return { val: "T", len: 0 };
      const v = arr[0];
      let l = 1;
      for (let i = 1; i < arr.length && arr[i] === v; i++) l++;
      return { val: v, len: l };
    })();

    const diceDirection = dice.bias >= 0 ? "T" : "X";
    if (streak.len >= 5) {
      // bệt dài
      if (dice.volatile && Math.abs(dice.bias) > 10) {
        chosen = { next: opp(streak.val), confidence: 70, label: "bệt dài + dice bẻ", action: "BẺ", type: "bet-long" };
      } else {
        chosen = { next: streak.val, confidence: 65, label: "bệt dài (theo)", action: "THEO", type: "bet-long" };
      }
    } else if (streak.len >= 3) {
      chosen = { next: streak.val, confidence: 58, label: "bệt ngắn (theo)", action: "THEO", type: "bet-short" };
    } else {
      // fallback dice
      chosen = { next: diceDirection, confidence: Math.min(60, 45 + Math.abs(dice.bias) * 0.3), label: "phân tích xúc xắc", action: diceDirection === arr[0] ? "THEO" : "BẺ", type: "dice" };
    }
  }

  // Hậu kiểm thống kê loại cầu để điều chỉnh confidence
  const typeKey = chosen.type;
  if (PATTERN_STATS[typeKey]) {
    const stats = PATTERN_STATS[typeKey];
    const acc = stats.total ? stats.correct / stats.total : 0.5;
    if (acc < 0.4 && stats.total >= 5) {
      chosen.confidence = Math.max(50, chosen.confidence - 10);
      chosen.label += " [giảm do thống kê yếu]";
    } else if (acc > 0.65 && stats.total >= 3) {
      chosen.confidence = Math.min(90, chosen.confidence + 5);
    }
  }

  // Chống dao động nhẹ nếu lật liên tục
  if (LAST_PREDICTION &&
      LAST_PREDICTION.side !== chosen.next &&
      chosen.type !== "early-break" &&
      Math.abs(chosen.confidence - LAST_PREDICTION.confidence) < 10) {
    // giữ nguyên nếu không đủ tự tin để lật
    chosen.next = LAST_PREDICTION.side;
    chosen.confidence = LAST_PREDICTION.confidence - 2;
    chosen.label += " (giữ)";
  }

  // Cập nhật LAST_PREDICTION
  LAST_PREDICTION = { side: chosen.next, confidence: chosen.confidence, type: chosen.type };

  const du_doan = chosen.next === "T" ? "tài" : "xỉu";
  return {
    du_doan,
    do_tin_cay: chosen.confidence,
    loai_cau: chosen.label,
    hanh_dong: chosen.action,
    canh_bao: `🎯 ${chosen.label} | ${du_doan} (${chosen.confidence}%)`,
    dice_info: dice
  };
}

// ═══════════════════════════════════════════════════════════
//  XỬ LÝ KIỂM TRA LỊCH SỬ & CẬP NHẬT PATTERN STATS
// ═══════════════════════════════════════════════════════════
function verifyHistory(parsed) {
  const phienMap = {};
  parsed.forEach(p => { phienMap[p.phien] = p; });

  for (const h of HISTORY) {
    if (h.checked) continue;
    const real = phienMap[h.phien_thuc_hien];
    if (real !== undefined) {
      h.checked = true;
      h.thuc_te = real.ket_qua;
      h.xuc_xac_thuc = real.xuc_xac;
      h.dung = h.du_doan === real.ket_qua;

      // Cập nhật pattern stats
      const type = h.pattern_type || "other";
      if (!PATTERN_STATS[type]) PATTERN_STATS[type] = { total: 0, correct: 0 };
      PATTERN_STATS[type].total++;
      if (h.dung) PATTERN_STATS[type].correct++;

      if (!h.dung) CONSECUTIVE_ERRORS++;
      else CONSECUTIVE_ERRORS = 0;
    }
  }
  if (HISTORY.length > 300) HISTORY = HISTORY.slice(-300);
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
    const res = await axios.get(API_URL, { timeout: 8000 });
    let sessions = res.data?.list || [];
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
    const pred = finalPredict(parsed);
    const latestP = parsed[0].phien;

    // Ghi dự đoán cho phiên mới
    if (latestP !== lastPhien) {
      lastPhien = latestP;
      HISTORY.push({
        phien_du_doan: latestP,
        phien_thuc_hien: latestP + 1,
        du_doan: pred.du_doan,
        pattern_type: pred.loai_cau?.split(" ")[0] || "other", // lưu loại để thống kê
        loai_cau: pred.loai_cau,
        hanh_dong: pred.hanh_dong,
        do_tin_cay: pred.do_tin_cay,
        timestamp: new Date().toISOString(),
        checked: false, thuc_te: null, xuc_xac_thuc: null, dung: null
      });
    }

    // Kết quả gần nhất đã kiểm chứng
    const lastVerified = [...HISTORY].reverse().find(h => h.checked);
    const ket_qua_gan_nhat = lastVerified ? {
      phien: lastVerified.phien_thuc_hien,
      du_doan: lastVerified.du_doan,
      thuc_te: lastVerified.thuc_te,
      xuc_xac: lastVerified.xuc_xac_thuc,
      dung: lastVerified.dung,
      icon: lastVerified.dung ? "✅" : "❌"
    } : null;

    const s10 = parsed.slice(0, 10);
    CACHE = {
      phien: latestP,
      ket_qua: parsed[0].ket_qua,
      xuc_xac: parsed[0].xuc_xac,
      du_doan: pred.du_doan,
      do_tin_cay: pred.do_tin_cay + "%",
      cau_dang_chay: arr.slice(0, 15).join(""),
      loai_cau: pred.loai_cau,
      hanh_dong: pred.hanh_dong,
      canh_bao: pred.canh_bao,
      ty_le_tai: Math.round(s10.filter(i => i.ket_qua === "tài").length / 10 * 100) + "%",
      ty_le_xiu: Math.round(s10.filter(i => i.ket_qua === "xỉu").length / 10 * 100) + "%",
      ket_qua_gan_nhat,
      do_chinh_xac: calcAccuracy(),
      recent_accuracy: calcAccuracy(20),
      consecutive_errors: CONSECUTIVE_ERRORS,
      dice_debug: pred.dice_info,
      pattern_stats: PATTERN_STATS,
      cap_nhat: new Date().toLocaleTimeString("vi-VN")
    };

    console.log(
      `[${CACHE.cap_nhat}] #${latestP} | ${pred.loai_cau} | ${pred.hanh_dong} → ${pred.du_doan} (${pred.do_tin_cay}%)` +
      ` | Acc-All: ${CACHE.do_chinh_xac} | Acc-20: ${CACHE.recent_accuracy}`
    );
  } catch (err) {
    console.error("Lỗi API:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════
//  ENDPOINTS
// ═══════════════════════════════════════════════════════════
app.get("/", (req, res) => res.json(CACHE));
app.get("/predict", (req, res) => res.json({ status: "success", data: CACHE }));
app.get("/history", (req, res) => {
  const checked = HISTORY.filter(h => h.checked).slice(-50).reverse();
  res.json({ status: "success", count: checked.length, data: checked });
});
app.get("/stats", (req, res) => {
  const done = HISTORY.filter(h => h.checked);
  const correct = done.filter(h => h.dung).length;
  const byType = { ...PATTERN_STATS };
  res.json({
    status: "success",
    total: done.length,
    correct,
    accuracy_all: calcAccuracy(),
    accuracy_20: calcAccuracy(20),
    accuracy_50: calcAccuracy(50),
    by_pattern: byType,
    consecutive_errors: CONSECUTIVE_ERRORS
  });
});
app.get("/algorithms", (req, res) => res.json({
  status: "success",
  version: "v6",
  method: "Pro Pattern Engine: phát hiện chu kỳ (1-1,1-2,2-1,3-3,4-4,5-5,3-1-3...), kết hợp phân tích xúc xắc xu hướng + hồi quy, tự động theo/bẻ cầu dựa trên độ ổn định chu kỳ, điều chỉnh theo thống kê hiệu suất từng loại cầu."
}));

// ─── KHỞI ĐỘNG ───────────────────────────────────────────
updateData();
setInterval(updateData, 5000);
app.listen(PORT, () => {
  console.log(`\n🎲 Tài Xỉu AI v6 (Pro Pattern Engine) — cổng ${PORT}\n`);
});