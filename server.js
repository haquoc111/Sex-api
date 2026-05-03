// server.js
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================
// API gốc
// ==========================
const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=62385f65eb49fcb34c72a7d6489ad91d";

// ==========================
// Cache dữ liệu
// ==========================
let CACHE = {
  phien: "0",
  ket_qua: "đang tải",
  xuc_xac: "0-0-0",
  du_doan: "đang phân tích",
  do_tin_cay: "0%",
  cau_dang_chay: "-",
  loai_cau: "đang phân tích",
  canh_bao: "đang tải",
  ty_le_tai: "0%",
  ty_le_xiu: "0%",
  // Thông tin bổ sung từ các thuật toán mới
  thuat_toan: {},
  lich_su_du_doan: []
};

// Lưu lịch sử dự đoán để tính độ chính xác
let PREDICTION_HISTORY = [];

// ==========================
// Hàm tạo chuỗi cầu từ dữ liệu
// ==========================
function buildCauString(data, len = 12) {
  return data
    .slice(0, len)
    .map((i) => (i.ket_qua === "tài" ? "T" : "X"))
    .join("");
}

// ==========================
// Phân tích chuỗi liên tiếp (streak)
// ==========================
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

// ==========================
// Thống kê Tài/Xỉu trong N phiên
// ==========================
function stats(data, range = 20) {
  let tai = 0, xiu = 0;
  const sample = data.slice(0, range);
  sample.forEach(i => i.ket_qua === "tài" ? tai++ : xiu++);
  return { tai, xiu, total: sample.length };
}

// ==========================
// THUẬT TOÁN 1: Markov Chain
// Tính xác suất chuyển trạng thái từ lịch sử
// ==========================
function markovPredict(data, order = 2) {
  if (data.length < order + 5) return { du_doan: null, confidence: 0 };

  const arr = data.map(i => i.ket_qua === "tài" ? "T" : "X");

  // Xây dựng bảng chuyển trạng thái bậc `order`
  const transTable = {};
  for (let i = 0; i < arr.length - order; i++) {
    const state = arr.slice(i, i + order).join("");
    const next = arr[i + order];
    if (!transTable[state]) transTable[state] = { T: 0, X: 0 };
    transTable[state][next]++;
  }

  // Trạng thái hiện tại là `order` phiên gần nhất
  const currentState = arr.slice(0, order).join("");
  const trans = transTable[currentState];

  if (!trans) {
    // Thử bậc 1 nếu không tìm thấy bậc 2
    if (order > 1) return markovPredict(data, order - 1);
    return { du_doan: null, confidence: 0 };
  }

  const total = trans.T + trans.X;
  if (total < 3) return { du_doan: null, confidence: 0 }; // Quá ít mẫu

  const probT = trans.T / total;
  const probX = trans.X / total;

  const du_doan = probT >= probX ? "tài" : "xỉu";
  const confidence = Math.round(Math.max(probT, probX) * 100);

  return {
    du_doan,
    confidence,
    prob_tai: (probT * 100).toFixed(1) + "%",
    prob_xiu: (probX * 100).toFixed(1) + "%",
    samples: total,
    state: currentState
  };
}

// ==========================
// THUẬT TOÁN 2: Weighted Score (Trọng số theo thời gian)
// Phiên gần đây có trọng số cao hơn
// ==========================
function weightedPredict(data, window = 30) {
  if (data.length < 5) return { du_doan: null, confidence: 0 };

  const sample = data.slice(0, window);
  let scoreTai = 0, scoreXiu = 0;
  const n = sample.length;

  sample.forEach((item, idx) => {
    // Trọng số giảm dần theo cấp số mũ, phiên gần nhất = trọng số cao nhất
    const weight = Math.exp(-idx * 0.08); // decay factor 0.08
    if (item.ket_qua === "tài") scoreTai += weight;
    else scoreXiu += weight;
  });

  const totalScore = scoreTai + scoreXiu;
  const probT = scoreTai / totalScore;
  const probX = scoreXiu / totalScore;

  // Đảo chiều: nếu tài đang chiếm ưu thế nhiều, dự đoán xỉu (hồi quy trung bình)
  let du_doan, confidence;
  if (probT > 0.62) {
    du_doan = "xỉu";
    confidence = Math.round(probT * 100);
  } else if (probX > 0.62) {
    du_doan = "tài";
    confidence = Math.round(probX * 100);
  } else {
    // Cân bằng: theo phiên gần nhất
    du_doan = data[0].ket_qua;
    confidence = 55;
  }

  return {
    du_doan,
    confidence,
    score_tai: scoreTai.toFixed(2),
    score_xiu: scoreXiu.toFixed(2)
  };
}

// ==========================
// THUẬT TOÁN 3: Pattern Matching
// So khớp chuỗi 4-5 phiên cuối với lịch sử
// ==========================
function patternMatchPredict(data, patternLen = 4) {
  if (data.length < patternLen + 10) return { du_doan: null, confidence: 0 };

  const arr = data.map(i => i.ket_qua === "tài" ? "T" : "X");
  const currentPattern = arr.slice(0, patternLen).join("");

  let matchTai = 0, matchXiu = 0;

  // Tìm tất cả vị trí có cùng mẫu trong lịch sử
  for (let i = patternLen; i < arr.length - 1; i++) {
    const histPattern = arr.slice(i - patternLen, i).join("");
    if (histPattern === currentPattern) {
      // Kết quả phiên tiếp theo sau mẫu này
      if (arr[i] === "T") matchTai++;
      else matchXiu++;
    }
  }

  const total = matchTai + matchXiu;
  if (total < 2) {
    // Thử pattern ngắn hơn
    if (patternLen > 2) return patternMatchPredict(data, patternLen - 1);
    return { du_doan: null, confidence: 0 };
  }

  const probT = matchTai / total;
  const probX = matchXiu / total;
  const du_doan = probT >= probX ? "tài" : "xỉu";
  const confidence = Math.round(Math.max(probT, probX) * 100);

  return {
    du_doan,
    confidence,
    pattern: currentPattern,
    matches: total,
    match_tai: matchTai,
    match_xiu: matchXiu
  };
}

// ==========================
// THUẬT TOÁN 4: Dice Score Analysis
// Phân tích xu hướng tổng điểm xúc xắc
// ==========================
function diceScorePredict(data, window = 15) {
  if (data.length < window) return { du_doan: null, confidence: 0 };

  const sample = data.slice(0, window);
  const totals = sample.map(i => i.total);

  // Tính trung bình động 3 phiên gần nhất vs trung bình tổng thể
  const avgRecent = (totals[0] + totals[1] + totals[2]) / 3;
  const avgAll = totals.reduce((a, b) => a + b, 0) / totals.length;

  // Phân tích phân phối điểm
  const highScores = totals.filter(t => t >= 11).length; // 11-18 = Tài
  const lowScores = totals.filter(t => t <= 10).length;  // 3-10 = Xỉu

  // Nếu điểm gần đây cao liên tục → xu hướng về xỉu (hồi quy)
  const recentTrend = avgRecent > 11.5 ? "high" : avgRecent < 9.5 ? "low" : "neutral";

  let du_doan, confidence;
  if (recentTrend === "high" && avgRecent > avgAll + 1.5) {
    du_doan = "xỉu";
    confidence = 68;
  } else if (recentTrend === "low" && avgRecent < avgAll - 1.5) {
    du_doan = "tài";
    confidence = 68;
  } else if (highScores > lowScores * 1.5) {
    du_doan = "xỉu";
    confidence = 65;
  } else if (lowScores > highScores * 1.5) {
    du_doan = "tài";
    confidence = 65;
  } else {
    du_doan = data[0].ket_qua === "tài" ? "xỉu" : "tài";
    confidence = 55;
  }

  return {
    du_doan,
    confidence,
    avg_recent: avgRecent.toFixed(2),
    avg_all: avgAll.toFixed(2),
    trend: recentTrend
  };
}

// ==========================
// THUẬT TOÁN 5: Ensemble Voting
// Kết hợp tất cả thuật toán, bỏ phiếu có trọng số
// ==========================
function ensemblePredict(data) {
  const markov   = markovPredict(data, 2);
  const weighted = weightedPredict(data, 30);
  const pattern  = patternMatchPredict(data, 4);
  const dice     = diceScorePredict(data, 15);

  // Trọng số của từng thuật toán (tổng = 1.0)
  const weights = {
    markov:   0.35,
    weighted: 0.25,
    pattern:  0.25,
    dice:     0.15
  };

  let scoreTai = 0, scoreXiu = 0, totalWeight = 0;

  const sources = [
    { name: "markov",   result: markov,   weight: weights.markov },
    { name: "weighted", result: weighted, weight: weights.weighted },
    { name: "pattern",  result: pattern,  weight: weights.pattern },
    { name: "dice",     result: dice,     weight: weights.dice }
  ];

  sources.forEach(({ result, weight }) => {
    if (!result.du_doan) return; // bỏ qua thuật toán không có kết quả
    const effectiveWeight = weight * (result.confidence / 100);
    if (result.du_doan === "tài") scoreTai += effectiveWeight;
    else scoreXiu += effectiveWeight;
    totalWeight += effectiveWeight;
  });

  if (totalWeight === 0) return null;

  const probTai = scoreTai / totalWeight;
  const probXiu = scoreXiu / totalWeight;
  const du_doan = probTai >= probXiu ? "tài" : "xỉu";
  const confidence = Math.round(Math.max(probTai, probXiu) * 100);

  return {
    du_doan,
    confidence: Math.min(92, Math.max(55, confidence)),
    vote_tai: (probTai * 100).toFixed(1) + "%",
    vote_xiu: (probXiu * 100).toFixed(1) + "%",
    details: {
      markov:   { du_doan: markov.du_doan,   confidence: markov.confidence   },
      weighted: { du_doan: weighted.du_doan, confidence: weighted.confidence },
      pattern:  { du_doan: pattern.du_doan,  confidence: pattern.confidence  },
      dice:     { du_doan: dice.du_doan,     confidence: dice.confidence     }
    }
  };
}

// ==========================
// Phát hiện mẫu cầu dựa vào dữ liệu API
// ==========================
function analyzePattern(data) {
  const len = data.length;
  if (len < 6) return { type: "không đủ dữ liệu", confidence: 0, breakSignal: false };

  const arr = data.slice(0, 20).map(i => i.ket_qua === "tài" ? "T" : "X");
  const streak = getStreak(data);
  const stats10 = stats(data, 10);

  // 1. Cầu bệt (streak >= 5)
  if (streak.count >= 5) {
    const isLong = streak.count >= 7;
    return {
      type: `bệt ${streak.side}`,
      confidence: 80,
      breakSignal: isLong,
      breakDirection: streak.side === "tài" ? "xỉu" : "tài"
    };
  }

  // 2. Cầu 1-1 (ít nhất 6 phiên xen kẽ)
  let is1_1 = true;
  for (let i = 1; i < Math.min(10, arr.length); i++) {
    if (arr[i] === arr[i - 1]) { is1_1 = false; break; }
  }
  if (is1_1 && arr.length >= 6) {
    return { type: "1-1", confidence: 85, breakSignal: false };
  }

  // 3. Cầu 2-2
  let is2_2 = true;
  for (let i = 0; i < Math.min(8, arr.length - 1); i += 2) {
    if (arr[i] !== arr[i + 1]) { is2_2 = false; break; }
    if (i > 0 && arr[i] === arr[i - 2]) { is2_2 = false; break; }
  }
  if (is2_2 && arr.length >= 6) {
    const pairs = Math.floor(arr.length / 2);
    return {
      type: "2-2",
      confidence: 78,
      breakSignal: pairs >= 6,
      breakDirection: arr[0] === "T" ? "xỉu" : "tài"
    };
  }

  // 4. Cầu 1-2
  let is1_2 = true;
  const first = arr[0];
  for (let i = 0; i < Math.min(9, arr.length - 2); i += 3) {
    if (arr[i] !== first || arr[i+1] !== (first === "T" ? "X" : "T") || arr[i+2] !== (first === "T" ? "X" : "T")) {
      is1_2 = false; break;
    }
  }
  if (is1_2 && arr.length >= 6) {
    const cycles = Math.floor(arr.length / 3);
    return {
      type: "1-2",
      confidence: 75,
      breakSignal: cycles >= 5,
      breakDirection: first === "T" ? "xỉu" : "tài"
    };
  }

  // 5. Cầu 3-3
  let is3_3 = true;
  if (arr.length < 6) is3_3 = false;
  else {
    const block1 = arr[0];
    for (let i = 0; i < 3; i++) if (arr[i] !== block1) { is3_3 = false; break; }
    for (let i = 3; i < 6; i++) if (arr[i] === block1) { is3_3 = false; break; }
    if (is3_3 && arr.length >= 9) {
      for (let i = 6; i < 9; i++) if (arr[i] !== block1) { is3_3 = false; break; }
    }
  }
  if (is3_3 && arr.length >= 6) {
    const blocks = Math.floor(arr.length / 3);
    return {
      type: "3-3",
      confidence: 85,
      breakSignal: blocks >= 4,
      breakDirection: arr[0] === "T" ? "xỉu" : "tài"
    };
  }

  // 6. Mất cân bằng lớn trong 10 phiên
  const ratioTai = stats10.tai / stats10.total;
  const ratioXiu = stats10.xiu / stats10.total;
  if (ratioTai > 0.7 || ratioXiu > 0.7) {
    const dominant = ratioTai > 0.7 ? "tài" : "xỉu";
    return {
      type: `nghiêng ${dominant}`,
      confidence: 72,
      breakSignal: true,
      breakDirection: dominant === "tài" ? "xỉu" : "tài"
    };
  }

  return { type: "không rõ", confidence: 55, breakSignal: false };
}

// ==========================
// Dự đoán cơ bản dựa trên loại cầu
// ==========================
function predictByPattern(data) {
  if (!data.length) return { du_doan: "tài", do_tin_cay: 50, loai_cau: "không có dữ liệu", canh_bao: "chưa có dữ liệu" };

  const pattern = analyzePattern(data);
  let du_doan = data[0].ket_qua;
  let confidence = pattern.confidence;
  let canh_bao = "";

  switch (true) {
    case pattern.type.startsWith("bệt"):
      if (pattern.breakSignal) {
        du_doan = pattern.breakDirection;
        canh_bao = `BẺ CẦU (bệt dài >6) ➡️ Đánh ${du_doan.toUpperCase()}`;
        confidence = 92;
      } else {
        du_doan = pattern.type.includes("tài") ? "tài" : "xỉu";
        canh_bao = `THEO CẦU BỆT ${du_doan.toUpperCase()}`;
        confidence = Math.min(85, confidence);
      }
      break;

    case pattern.type === "1-1":
      du_doan = data[0].ket_qua === "tài" ? "xỉu" : "tài";
      canh_bao = "CẦU 1-1 (đảo chiều)";
      confidence = 88;
      break;

    case pattern.type === "2-2":
      if (pattern.breakSignal) {
        du_doan = pattern.breakDirection;
        canh_bao = `BẺ CẦU 2-2 ➡️ Đánh ${du_doan.toUpperCase()}`;
        confidence = 85;
      } else {
        const lastTwo = data.slice(0, 2).map(i => i.ket_qua);
        du_doan = lastTwo[0];
        canh_bao = "THEO CẦU 2-2";
        confidence = 78;
      }
      break;

    case pattern.type === "1-2":
      if (pattern.breakSignal) {
        du_doan = pattern.breakDirection;
        canh_bao = `BẺ CẦU 1-2 ➡️ Đánh ${du_doan.toUpperCase()}`;
        confidence = 82;
      } else {
        du_doan = data[0].ket_qua === "tài" ? "xỉu" : "tài";
        canh_bao = "THEO CẦU 1-2";
        confidence = 75;
      }
      break;

    case pattern.type === "3-3":
      if (pattern.breakSignal) {
        du_doan = pattern.breakDirection;
        canh_bao = `BẺ CẦU 3-3 ➡️ Đánh ${du_doan.toUpperCase()}`;
        confidence = 90;
      } else {
        const streak = getStreak(data);
        du_doan = streak.count < 3 ? streak.side : (streak.side === "tài" ? "xỉu" : "tài");
        canh_bao = "THEO CẦU 3-3";
        confidence = 85;
      }
      break;

    case pattern.type.startsWith("nghiêng"):
      du_doan = pattern.breakDirection;
      canh_bao = `MẤT CÂN BẰNG ➡️ Bẻ sang ${du_doan.toUpperCase()}`;
      confidence = 85;
      break;

    default: {
      const s15 = stats(data, 15);
      if (s15.tai > s15.xiu + 2) {
        du_doan = "xỉu";
        canh_bao = "Đảo xu hướng (nhiều Tài)";
        confidence = 62;
      } else if (s15.xiu > s15.tai + 2) {
        du_doan = "tài";
        canh_bao = "Đảo xu hướng (nhiều Xỉu)";
        confidence = 62;
      } else {
        du_doan = data[0].ket_qua === "tài" ? "xỉu" : "tài";
        canh_bao = "Cân bằng, đảo chiều";
        confidence = 55;
      }
    }
  }

  return { du_doan, do_tin_cay: confidence, loai_cau: pattern.type, canh_bao };
}

// ==========================
// HÀM DỰ ĐOÁN TỔNG HỢP (Kết hợp tất cả)
// ==========================
function predict(data) {
  if (!data.length) return {
    du_doan: "tài",
    do_tin_cay: "50%",
    loai_cau: "không có dữ liệu",
    canh_bao: "chưa có dữ liệu",
    ty_le_tai: "0%",
    ty_le_xiu: "0%",
    thuat_toan: {}
  };

  // Chạy dự đoán theo cầu (logic cũ, đáng tin cậy)
  const byPattern  = predictByPattern(data);

  // Chạy Ensemble (4 thuật toán AI)
  const ensemble   = ensemblePredict(data);

  // ==========================
  // Kết hợp cuối cùng:
  // - Nếu cả byPattern và ensemble đồng thuận → confidence cao
  // - Nếu trái chiều → dùng ensemble (trọng số cao hơn) nhưng giảm confidence
  // ==========================
  let final_du_doan, final_confidence, final_canh_bao;

  if (!ensemble) {
    // Không đủ dữ liệu cho ensemble → dùng byPattern
    final_du_doan      = byPattern.du_doan;
    final_confidence   = byPattern.do_tin_cay;
    final_canh_bao     = byPattern.canh_bao;
  } else if (byPattern.du_doan === ensemble.du_doan) {
    // Đồng thuận → boost confidence
    final_du_doan    = byPattern.du_doan;
    final_confidence = Math.min(95, Math.round((byPattern.do_tin_cay * 0.4 + ensemble.confidence * 0.6) * 1.05));
    final_canh_bao   = `✅ ${byPattern.canh_bao} [AI đồng thuận]`;
  } else {
    // Trái chiều → nghiêng về ensemble nhưng giảm tin cậy
    final_du_doan    = ensemble.du_doan;
    final_confidence = Math.min(75, Math.round(ensemble.confidence * 0.85));
    final_canh_bao   = `⚠️ Tín hiệu trái chiều → AI: ${ensemble.du_doan.toUpperCase()} | Cầu: ${byPattern.du_doan.toUpperCase()}`;
  }

  // Tính tỉ lệ 10 phiên
  const s10 = stats(data, 10);
  const tyLeTai = ((s10.tai / s10.total) * 100).toFixed(0) + "%";
  const tyLeXiu = ((s10.xiu / s10.total) * 100).toFixed(0) + "%";

  return {
    du_doan:    final_du_doan,
    do_tin_cay: Math.min(95, Math.max(52, final_confidence)) + "%",
    loai_cau:   byPattern.loai_cau,
    canh_bao:   final_canh_bao,
    ty_le_tai:  tyLeTai,
    ty_le_xiu:  tyLeXiu,
    thuat_toan: ensemble ? {
      markov:   ensemble.details.markov,
      weighted: ensemble.details.weighted,
      pattern:  ensemble.details.pattern,
      dice:     ensemble.details.dice,
      ensemble: { du_doan: ensemble.du_doan, confidence: ensemble.confidence, vote_tai: ensemble.vote_tai, vote_xiu: ensemble.vote_xiu },
      cau:      { du_doan: byPattern.du_doan, confidence: byPattern.do_tin_cay }
    } : {}
  };
}

// ==========================
// Lấy dữ liệu từ API gốc và cập nhật cache
// ==========================
async function updateData() {
  try {
    const res = await axios.get(API_URL);
    const json = res.data;
    let sessions = json.list || [];

    if (!Array.isArray(sessions) || sessions.length === 0) {
      console.log("Không có dữ liệu từ API");
      return;
    }

    // Sắp xếp giảm dần theo id (mới nhất trước), lấy 100 phiên
    sessions.sort((a, b) => b.id - a.id);
    sessions = sessions.slice(0, 100);

    // Chuẩn hóa dữ liệu
    const parsed = sessions.map(item => {
      const dices = item.dices || [1, 1, 1];
      const x1 = dices[0] || 1;
      const x2 = dices[1] || 1;
      const x3 = dices[2] || 1;
      const total = x1 + x2 + x3;
      const ket_qua = item.resultTruyenThong === "TAI" ? "tài" : "xỉu";
      return {
        phien: item.id,
        ket_qua,
        xuc_xac: `${x1}-${x2}-${x3}`,
        total
      };
    });

    // Kiểm tra độ chính xác dự đoán trước (nếu có)
    if (PREDICTION_HISTORY.length > 0) {
      const lastPred = PREDICTION_HISTORY[PREDICTION_HISTORY.length - 1];
      const actual = parsed.find(p => p.phien === lastPred.phien + 1);
      if (actual && !lastPred.checked) {
        lastPred.checked = true;
        lastPred.actual = actual.ket_qua;
        lastPred.correct = lastPred.du_doan === actual.ket_qua;
      }
    }

    // Dự đoán dựa trên dữ liệu đã parse
    const prediction = predict(parsed);

    // Lưu dự đoán vào lịch sử
    PREDICTION_HISTORY.push({
      phien: parsed[0].phien,
      du_doan: prediction.du_doan,
      do_tin_cay: prediction.do_tin_cay,
      timestamp: new Date().toISOString(),
      checked: false,
      actual: null,
      correct: null
    });
    if (PREDICTION_HISTORY.length > 50) PREDICTION_HISTORY.shift();

    // Tính độ chính xác tổng thể
    const checked = PREDICTION_HISTORY.filter(p => p.checked);
    const accuracy = checked.length > 0
      ? ((checked.filter(p => p.correct).length / checked.length) * 100).toFixed(1) + "%"
      : "chưa có dữ liệu";

    CACHE = {
      phien:        parsed[0].phien,
      ket_qua:      parsed[0].ket_qua,
      xuc_xac:      parsed[0].xuc_xac,
      du_doan:      prediction.du_doan,
      do_tin_cay:   prediction.do_tin_cay,
      cau_dang_chay: buildCauString(parsed, 15),
      loai_cau:     prediction.loai_cau,
      canh_bao:     prediction.canh_bao,
      ty_le_tai:    prediction.ty_le_tai,
      ty_le_xiu:    prediction.ty_le_xiu,
      thuat_toan:   prediction.thuat_toan,
      do_chinh_xac: accuracy,
      cap_nhat:     new Date().toLocaleTimeString("vi-VN")
    };

    console.log(
      `[${CACHE.cap_nhat}] Phiên ${CACHE.phien} | KQ: ${CACHE.ket_qua} | Dự đoán: ${CACHE.du_doan} | ${CACHE.do_tin_cay} | ${CACHE.canh_bao}`
    );
  } catch (err) {
    console.log("Lỗi API:", err.message);
  }
}

// ==========================
// Endpoints
// ==========================
app.get("/", (req, res) => {
  res.json(CACHE);
});

app.get("/predict", (req, res) => {
  res.json({
    status: "success",
    data: CACHE
  });
});

// Endpoint xem chi tiết từng thuật toán
app.get("/algorithms", (req, res) => {
  res.json({
    status: "success",
    thuat_toan: CACHE.thuat_toan,
    ghi_chu: {
      markov:   "Xác suất chuyển trạng thái bậc 2 (chuỗi 2 phiên liên tiếp)",
      weighted: "Trọng số giảm dần theo thời gian, phiên gần đây ảnh hưởng nhiều hơn",
      pattern:  "Khớp mẫu 4 phiên cuối với toàn bộ lịch sử",
      dice:     "Phân tích xu hướng tổng điểm xúc xắc",
      ensemble: "Bỏ phiếu có trọng số: markov(35%) + weighted(25%) + pattern(25%) + dice(15%)"
    }
  });
});

// Endpoint xem lịch sử dự đoán và độ chính xác
app.get("/accuracy", (req, res) => {
  const checked = PREDICTION_HISTORY.filter(p => p.checked);
  const correct = checked.filter(p => p.correct).length;
  res.json({
    status: "success",
    tong_du_doan:  PREDICTION_HISTORY.length,
    da_kiem_tra:   checked.length,
    chinh_xac:     correct,
    sai:           checked.length - correct,
    ty_le_chinh_xac: checked.length > 0
      ? ((correct / checked.length) * 100).toFixed(1) + "%"
      : "chưa có dữ liệu",
    lich_su: PREDICTION_HISTORY.slice(-20).reverse()
  });
});

// ==========================
// Khởi động
// ==========================
updateData();
setInterval(updateData, 5000);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Endpoints:");
  console.log("  GET /         → cache tổng hợp");
  console.log("  GET /predict  → dự đoán đầy đủ");
  console.log("  GET /algorithms → chi tiết từng thuật toán");
  console.log("  GET /accuracy   → lịch sử & độ chính xác");
});
