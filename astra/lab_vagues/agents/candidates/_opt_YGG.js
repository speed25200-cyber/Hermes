// Variante optimisée (sorties) de YGG volume_3 : TP +40 act +30 24h (worst 6.20 -> 8.92 au banc)
const base = require("./volume_3.js");
module.exports = { ...base, exits: { tp: 0.40, sl: 0.30, act: 0.30, cb: 0.05, holdH: 24 } };
