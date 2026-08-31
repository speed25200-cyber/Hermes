const fs = require("fs");
let modelDir=null;
function init({ modelDir:dir }){ modelDir=dir; if(!fs.existsSync("models")) fs.mkdirSync("models"); }
module.exports = { init };
