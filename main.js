const { app, BrowserWindow, dialog } = require('electron');
const { fork } = require('child_process');
const { autoUpdater } = require('electron-updater');
const path = require('path');

let serverProcess = null;
let mainWindow = null;

autoUpdater.autoDownload = false;

function startServer() {
    const serverPath = path.join(__dirname, 'server.js');
    serverProcess = fork(serverPath, [`--user-data=${app.getPath('userData')}`]);

    serverProcess.on('error', (err) => {
        console.error('Falha ao iniciar o processo do servidor Express:', err);
    });

    serverProcess.on('exit', (code) => {
        console.log(`Servidor Express finalizou com o código: ${code}`);
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "Central de Roteiros",
        icon: path.join(__dirname, 'assets', 'tutorial-icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.setMenu(null);
    mainWindow.loadURL('http://localhost:3000');

    mainWindow.webContents.once('did-finish-load', () => {
        if (app.isPackaged) {
            autoUpdater.checkForUpdates();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F12') {
            if (mainWindow.webContents.isDevToolsOpened()) {
                mainWindow.webContents.closeDevTools();
            } else {
                mainWindow.webContents.openDevTools({
                    mode: 'detach'
                });
            }
            event.preventDefault();
        }
    });
}

app.whenReady().then(() => {
    startServer();
    setTimeout(createWindow, 500);
    
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (serverProcess) {
        serverProcess.kill();
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('quit', () => {
    if (serverProcess) {
        serverProcess.kill();
    }
});

/*
 * ==========================================
 *          AUTO UPDATER 
 * ==========================================
 */
autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox({
        type: 'info',
        title: 'Atualização Disponível',
        message: `Uma nova versão (${info.version}) está disponível. Deseja baixar agora?`,
        buttons: ['Sim', 'Depois'],
        defaultId: 0,
        cancelId: 1
    }).then((result) => {
        if (result.response === 0) {
            autoUpdater.downloadUpdate();
        }
    });
});

autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
        type: 'info',
        title: 'Atualização Pronta',
        message: 'A nova versão foi baixada com sucesso! O aplicativo será reiniciado para concluir a instalação.',
        buttons: ['Instalar e Reiniciar']
    }).then(() => {
        if (serverProcess) {
            serverProcess.kill();
        }
        autoUpdater.quitAndInstall();
    });
});

autoUpdater.on('error', (err) => {
    console.error('Erro no atualizador automático:', err);
});