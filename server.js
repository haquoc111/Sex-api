const express = require("express");
const axios = require("axios");

const app = express();

const PORT = process.env.PORT || 3000;

// ===========================
// API GỐC
// ===========================

const API =
  "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=62385f65eb49fcb34c72a7d6489ad91d";

let HISTORY = [];

// ===========================
// PHÂN LOẠI TÀI/XỈU
// ===========================

function getResult(total) {
  return total >= 11 ? "TÀI" : "XỈU";
}

// ===========================
// AI VIP THUẬT TOÁN
// ===========================

function advancedPredict(history) {
  if (!history || history.length < 20) {
    return {
      result: "TÀI",
      confidence: 50,
      reason: "Không đủ dữ liệu"
    };
  }

  const arr = history.map(i => i.result);

  let scoreTai = 0;
  let scoreXiu = 0;

  const last = arr[arr.length - 1];
  const last2 = arr[arr.length - 2];
  const last3 = arr[arr.length - 3];
  const last4 = arr[arr.length - 4];

  // =========================
  // CẦU BỆT
  // =========================

  let streak = 1;

  for (let i = arr.length - 1; i > 0; i--) {
    if (arr[i] === arr[i - 1]) streak++;
    else break;
  }

  if (last === "TÀI") scoreTai += streak * 7;
  else scoreXiu += streak * 7;

  // =========================
  // CẦU 1-1
  // =========================

  let alternating = true;

  for (let i = arr.length - 6; i < arr.length - 1; i++) {
    if (arr[i] === arr[i + 1]) {
      alternating = false;
      break;
    }
  }

  if (alternating) {
    if (last === "TÀI") scoreXiu += 18;
    else scoreTai += 18;
  }

  // =========================
  // CẦU 2-2
  // =========================

  const pattern22 =
    last === last2 &&
    last3 === last4 &&
    last !== last3;

  if (pattern22) {
    if (last === "TÀI") scoreXiu += 15;
    else scoreTai += 15;
  }

  // =========================
  // FAKE DETECTOR
  // =========================

  if (streak >= 5) {
    if (last === "TÀI") {
      scoreTai -= 10;
      scoreXiu += 12;
    } else {
      scoreXiu -= 10;
      scoreTai += 12;
    }
  }

  // =========================
  // THỐNG KÊ NGẮN
  // =========================

  const short = arr.slice(-15);

  let shortTai = short.filter(x => x === "TÀI").length;
  let shortXiu = short.filter(x => x === "XỈU").length;

  if (shortTai > shortXiu + 4) {
    scoreXiu += 10;
  }

  if (shortXiu > shortTai + 4) {
    scoreTai += 10;
  }

  // =========================
  // CẦU GÃY
  // =========================

  let breaks = 0;

  for (let i = arr.length - 10; i < arr.length - 1; i++) {
    if (arr[i] !== arr[i + 1]) breaks++;
  }

  if (breaks >= 7) {
    scoreTai += 5;
    scoreXiu += 5;
  }

  // =========================
  // NHẬN DIỆN CẦU ĐẸP
  // =========================

  let repeat2 = 0;

  for (let i = arr.length - 8; i < arr.length - 2; i++) {
    if (
      arr[i] === arr[i + 1] &&
      arr[i + 2] === arr[i + 3] &&
      arr[i] !== arr[i + 2]
    ) {
      repeat2++;
    }
  }

  if (repeat2 >= 2) {
    if (last === "TÀI") scoreXiu += 12;
    else scoreTai += 12;
  }

  // =========================
  // AI CÂN BẰNG
  // =========================

  if (scoreTai > scoreXiu + 30) {
    scoreTai -= 10;
  }

  if (scoreXiu > scoreTai + 30) {
    scoreXiu -= 10;
  }

  // =========================
  // QUYẾT ĐỊNH
  // =========================

  let result = scoreTai >= scoreXiu ? "TÀI" : "XỈU";

  let diff = Math.abs(scoreTai - scoreXiu);

  let confidence = 50 + diff;

  if (confidence > 92) confidence = 92;

  if (diff <= 5) confidence = 55;

  // =========================
  // MODE AI
  // =========================

  let mode = "AI MIX";

  if (streak >= 5) {
    mode = "BẺ NHẸ CẦU VIP";
  } else if (alternating) {
    mode = "THEO CẦU 1-1";
  } else if (pattern22) {
    mode = "BẺ CẦU 2-2";
  }

  return {
    result,
    confidence,
    scoreTai,
    scoreXiu,
    streak,
    mode
  };
}

// ===========================
// UPDATE DATA
// ===========================

async function updateData() {
  try {

    const res = await axios.get(API);

    let raw = [];

    if (Array.isArray(res.data)) {
      raw = res.data;
    } else if (res.data.data) {
      raw = res.data.data;
    } else if (res.data.sessions) {
      raw = res.data.sessions;
    }

    const parsed = raw.map(item => {

      let dices = [];

      if (item.dices) {
        dices = item.dices;
      } else if (item.result) {
        dices = item.result;
      } else if (item.dice) {
        dices = item.dice;
      }

      const total = dices.reduce((a, b) => a + b, 0);

      return {
        session:
          item.session ||
          item.sid ||
          item.issue ||
          item.id,

        dices,

        total,

        result: getResult(total),

        time:
          item.time ||
          item.created_at ||
          Date.now()
      };
    });

    HISTORY = parsed.reverse();

    console.log("UPDATED:", HISTORY.length);

  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

// ===========================
// AUTO UPDATE
// ===========================

updateData();

setInterval(updateData, 3000);

// ===========================
// HOME
// ===========================

app.get("/", (req, res) => {

  const predict = advancedPredict(HISTORY);

  res.json({
    status: "running",

    total_history: HISTORY.length,

    du_doan: predict
  });
});

// ===========================
// HISTORY
// ===========================

app.get("/history", (req, res) => {

  res.json({
    total: HISTORY.length,

    history: HISTORY.slice(-100)
  });
});

// ===========================
// PREDICT
// ===========================

app.get("/predict", (req, res) => {

  const predict = advancedPredict(HISTORY);

  const last = HISTORY[HISTORY.length - 1];

  res.json({

    phien_gan_nhat: last?.session || null,

    xuc_xac: last?.dices || [],

    tong: last?.total || 0,

    ket_qua_truoc: last?.result || "",

    du_doan_phien_tiep: predict.result,

    do_tin_cay: predict.confidence + "%",

    che_do_ai: predict.mode,

    streak: predict.streak,

    score_tai: predict.scoreTai,

    score_xiu: predict.scoreXiu
  });
});

// ===========================
// SERVER
// ===========================

app.listen(PORT, () => {
  console.log("SERVER RUNNING PORT", PORT);
});