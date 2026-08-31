const {app,BrowserWindow} = require("electron");

function createWindow(){
  const win = new BrowserWindow({
    width: 1000, height: 700,
    backgroundColor: "#121212",
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.loadURL("data:text/html,<h1 style=margin:40px;color:white;font-family:sans-serif>Smoke OK</h1>");
}

app.on("ready", createWindow);
app.on("window-all-closed", ()=>{ if(process.platform!=="darwin") app.quit(); });
app.on("activate", ()=>{ if(BrowserWindow.getAllWindows().length===0) createWindow(); });