const { Client, LocalAuth, Buttons, MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');

let client;
let clientReady = false;
let latestQR = null;

/**
 * Initialize WhatsApp Client (singleton)
 */
function initializeClient() {
    if (client) return client; // Reuse instance if exists

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'default',
            dataPath: path.join(__dirname, 'whatsapp-session')
        }),
        puppeteer: { headless: false }
    });

    // QR code
    client.on('qr', qr => {
        console.log('📱 Scan this QR Code to authenticate:');
        latestQR = qr;
        fs.writeFileSync(path.join(__dirname, 'latest-qr.txt'), qr);
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp client is ready!');
        clientReady = true;
    });

    client.on('authenticated', () => console.log('🔐 Authenticated successfully!'));
    client.on('auth_failure', msg => {
        console.error('❌ Authentication failure:', msg);
        clientReady = false;
    });
    client.on('disconnected', reason => {
        console.warn('⚠️ Client disconnected:', reason);
        clientReady = false;
    });

    client.initialize();
    return client;
}

/**
 * Wait for the client to be ready
 */
async function getClient() {
    const c = initializeClient();

    if (!clientReady) {
        await new Promise(resolve => {
            c.once('ready', () => {
                clientReady = true;
                resolve();
            });
        });
    }

    return c;
}

function getQR() {
    return { qr: latestQR };
}

module.exports = { initializeClient, getClient, getQR, Buttons, MessageMedia };
