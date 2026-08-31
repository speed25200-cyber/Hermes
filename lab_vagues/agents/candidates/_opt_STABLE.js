// Variante optimisée (sorties) de STABLE web_structure_2 : TP +80 act +20 12h (worst 6.12 -> 7.91 au banc)
const base = require("./web_structure_2.js");
module.exports = { ...base, exits: { tp: 0.80, sl: 0.30, act: 0.20, cb: 0.05, holdH: 12 } };
