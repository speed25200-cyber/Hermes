// Variante optimisée (sorties) du champion O : TP +60 act +20 24h (worst 7.04 -> 9.30 au banc)
const base = require("./champions_5.js");
module.exports = { ...base, exits: { tp: 0.60, sl: 0.30, act: 0.20, cb: 0.05, holdH: 24 } };
