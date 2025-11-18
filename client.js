const { Client, LocalAuth, Buttons, MessageMedia } = require("whatsapp-web.js");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const MAX_ACTIVE_CLIENTS = parseInt(process.env.MAX_ACTIVE_CLIENTS) || 10;
const SESSION_TIMEOUT = 30 * 60 * 1000;

// 📦 GESTIONNAIRE CLIENTS CORRIGÉ
class WhatsAppClientManager {
  constructor() {
    this.clients = new Map(); // phoneNumber -> client
    this.clientStates = new Map(); // phoneNumber -> state
    this.sessionPath = path.join(__dirname, "whatsapp-sessions");
    this.initializationLocks = new Map();
    this.qrGenerationLocks = new Map();
    this.sessionQueue = [];
    this.session=[];
    this.yiiApiUrl = process.env.YII_API_URL || "http://localhost:8080";
    this.yiiApiSecret = process.env.YII_API_SECRET || "my_very_secret_key_123";

    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }

    setInterval(() => this.cleanupInactiveClients(), 5 * 60 * 1000);
  }

  /**
   * 🚀 Initialiser client par numéro
   */
  async initializeClient(phoneNumber, userId = null) {
    const clientKey = phoneNumber;

    if (this.initializationLocks.has(clientKey)) {
      console.log(`⏳ [${phoneNumber}] Client déjà en cours d'initialisation...`);
      return new Promise((resolve) => {
        const checkClient = () => {
          const client = this.clients.get(clientKey);
          if (client && this.clientStates.get(clientKey)?.initialized) {
            resolve(client);
          } else {
            setTimeout(checkClient, 500);
          }
        };
        checkClient();
      });
    }

    this.initializationLocks.set(clientKey, true);

    try {
      const existingClient = this.clients.get(clientKey);
      if (existingClient && (await this.isClientHealthy(clientKey))) {
        console.log(`♻️ [${phoneNumber}] Réutilisation client existant`);
        this.updateSessionActivity(clientKey);
        return existingClient;
      }

      if (this.clients.size >= MAX_ACTIVE_CLIENTS) {
        await this.deactivateOldestClient();
      }

      console.log(`🆕 [${phoneNumber}] Création client WhatsApp...`);

      const client = new Client({
        authStrategy: new LocalAuth({
          clientId: phoneNumber,
          dataPath: this.sessionPath,
        }),
        puppeteer: {
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--single-process",
            "--disable-gpu",
          ],
        },
        restartOnAuthFail: true,
      });

      this.clientStates.set(clientKey, {
        ready: false,
        qr: null,
        authenticated: false,
        lastActivity: Date.now(),
        initialized: true,
        qrGenerated: false,
      });

      this.setupEventHandlers(client, clientKey);
      client.initialize();

      this.clients.set(clientKey, client);
      this.updateSessionActivity(clientKey);

      return client;
    } finally {
      setTimeout(() => {
        this.initializationLocks.delete(clientKey);
      }, 2000);
    }
  }

  /**
   * 🎯 Configuration des événements
   */
  setupEventHandlers(client, clientKey) {
    const state = this.clientStates.get(clientKey);

    client.on("qr", (qr) => {
      if (state.qrGenerated) {
        console.log(`⚠️ [${clientKey}] QR déjà généré - Ignoré`);
        return;
      }

      console.log(`📱 [${clientKey}] QR code généré`);
      state.qr = qr;
      state.ready = false;
      state.authenticated = false;
      state.qrGenerated = true;
      state.lastActivity = Date.now();
    });

    client.on("authenticated", () => {
      console.log(`🔐 [${clientKey}] Authentifié - QR SCANNÉ!`);
      state.authenticated = true;
      state.lastActivity = Date.now();

      this.debitQrCodeCount(clientKey).catch((err) => {
        console.error(`❌ [${clientKey}] Erreur débit:`, err.message);
      });
    });

    client.on("ready", () => {
      console.log(`✅ [${clientKey}] WhatsApp PRÊT`);
      state.ready = true;
      state.qr = null;
      state.authenticated = true;
      state.lastActivity = Date.now();
    });

    client.on("auth_failure", (msg) => {
      console.error(`❌ [${clientKey}] Échec auth:`, msg);
      state.qrGenerated = false;
    });

    client.on("disconnected", (reason) => {
      console.warn(`⚠️ [${clientKey}] Déconnecté:`, reason);
      state.ready = false;
      state.authenticated = false;
      state.qrGenerated = false;
    });
  }

  /**
   * 🔍 GÉNÉRER QR CODE
   */
  async generateNewQR(phoneNumber, userId = null) {
    if (this.qrGenerationLocks.has(phoneNumber)) {
      console.log(`⏳ [${phoneNumber}] QR déjà en cours de génération...`);
      return new Promise((resolve, reject) => {
        const checkQR = () => {
          const state = this.clientStates.get(phoneNumber);
          if (state && state.qr) {
            resolve({
              qr: state.qr,
              status: "qr_ready",
              ready: false,
              message: "QR déjà disponible",
            });
          } else if (state && state.ready) {
            resolve({
              status: "authenticated",
              message: "Déjà authentifié",
              ready: true,
            });
          } else if (!this.qrGenerationLocks.has(phoneNumber)) {
            reject(new Error("Échec génération QR"));
          } else {
            setTimeout(checkQR, 1000);
          }
        };
        checkQR();
      });
    }

    this.qrGenerationLocks.set(phoneNumber, true);
    console.log(`🎯 [${phoneNumber}] Demande QR code pour user ${userId}...`);

    try {
      const state = this.clientStates.get(phoneNumber);

      if (state && state.ready && state.authenticated) {
        console.log(`✅ [${phoneNumber}] Déjà authentifié`);
        if (userId) {
          await this.associatePhoneWithUser(userId, phoneNumber);
        }
        return {
          status: "authenticated",
          message: "WhatsApp déjà connecté",
          ready: true,
        };
      }

      if (state && state.qr) {
        console.log(`📱 [${phoneNumber}] QR déjà disponible`);
        if (userId) {
          await this.associatePhoneWithUser(userId, phoneNumber);
        }
        return {
          qr: state.qr,
          status: "qr_ready",
          ready: false,
          message: "Scannez ce QR",
        };
      }

      await this.initializeClient(phoneNumber, userId);

      if (userId) {
        await this.associatePhoneWithUser(userId, phoneNumber);
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("QR non généré après 30s"));
        }, 30000);

        const checkQR = () => {
          const currentState = this.clientStates.get(phoneNumber);

          if (currentState && currentState.qr) {
            clearTimeout(timeout);
            console.log(`✅ [${phoneNumber}] QR généré avec succès pour user ${userId}`);
            resolve({
              qr: currentState.qr,
              status: "qr_ready",
              ready: false,
              message: "Scannez ce QR avec WhatsApp",
            });
          } else if (currentState && currentState.ready) {
            clearTimeout(timeout);
            console.log(`✅ [${phoneNumber}] Déjà authentifié pendant l'attente`);
            resolve({
              status: "authenticated",
              message: "WhatsApp déjà connecté",
              ready: true,
            });
          } else {
            setTimeout(checkQR, 1000);
          }
        };

        checkQR();
      });
    } catch (error) {
      console.error(`❌ [${phoneNumber}] Erreur génération QR:`, error.message);
      throw error;
    } finally {
      setTimeout(() => {
        this.qrGenerationLocks.delete(phoneNumber);
      }, 2000);
    }
  }

  /**
   * 📨 ENVOYER MESSAGE
   */
  async sendMessage(messageData) {
    const { to, text, attachments, from } = messageData;
    const clientKey = from;

    if (!this.clients.has(clientKey)) {
      await this.initializeClient(from);
    }

    if (!(await this.isClientHealthy(clientKey))) {
      throw new Error(`WhatsApp non connecté sur ${from}`);
    }

    const client = this.clients.get(clientKey);
    const numberDetails = await client.getNumberId(to);

    if (!numberDetails) {
      throw new Error("Numéro non enregistré sur WhatsApp");
    }

    const chatId = numberDetails._serialized;

    if (attachments && Array.isArray(attachments)) {
      for (const attachment of attachments) {
        const media = await this.createMediaFromAttachment(attachment);
        await client.sendMessage(chatId, media, { caption: text });
      }
    } else if (text) {
      await client.sendMessage(chatId, text);
    }

    this.updateSessionActivity(clientKey);
    console.log(`✅ Message envoyé à ${to} depuis ${from}`);
    
    return {
      success: true,
      to,
      from,
    };
  }

  /**
   * 🆕 CHARGER UNE SESSION EXISTANTE
   */
  async loadExistingSession(phoneNumber) {
    const clientKey = phoneNumber;
    
    if (this.clients.has(clientKey) && await this.isClientHealthy(clientKey)) {
      return this.clients.get(clientKey);
    }

    const sessionFolder = path.join(this.sessionPath, `session-${phoneNumber}`);
    if (!fs.existsSync(sessionFolder)) {
      throw new Error(`Dossier session non trouvé: ${sessionFolder}`);
    }

    console.log(`🔄 Chargement session existante: ${phoneNumber}`);
    return await this.initializeClient(phoneNumber);
  }

  /**
   * 🆕 VÉRIFIER SI UNE SESSION EXISTE SUR LE DISQUE
   */
  sessionExistsOnDisk(phoneNumber) {
    const sessionFolder = path.join(this.sessionPath, `session-${phoneNumber}`);
    return fs.existsSync(sessionFolder);
  }

  /**
   * 🆕 LISTER TOUTES LES SESSIONS DISPONIBLES (DISQUE + MÉMOIRE)
   */
  getAllAvailableSessions() {
    const sessionsDir = this.sessionPath;
    const allSessions = [];
    
    try {
      if (fs.existsSync(sessionsDir)) {
        const folders = fs.readdirSync(sessionsDir);
        
        folders.forEach(folder => {
          if (folder.startsWith('session-user_')) {
            const phoneNumber = folder.replace('session-', '');
            const state = this.clientStates.get(phoneNumber);
            const existsInMemory = this.clients.has(phoneNumber);
            
            allSessions.push({
              phoneNumber: phoneNumber,
              folderName: folder,
              existsInMemory: existsInMemory,
              ready: state?.ready || false,
              authenticated: state?.authenticated || false,
              hasQR: !!state?.qr,
              lastActivity: state?.lastActivity || null,
              status: state ? (state.ready ? 'authenticated' : state.qr ? 'qr_ready' : 'waiting') : 'not_loaded'
            });
          }
        });
      }
    } catch (error) {
      console.error("❌ Erreur scan sessions:", error);
    }
    
    return allSessions;
  }

  /**
   * 🆕 ASSOCIER UN NUMÉRO À UN UTILISATEUR
   */
  async associatePhoneWithUser(userId, phoneNumber) {
    try {
      console.log(`🔗 Association ${phoneNumber} avec user ${userId}`);
      
      const response = await axios.post(
        `${this.yiiApiUrl}/api/associate-phone`,
        {
          user_id: userId,
          phone_number: phoneNumber,
          secret: this.yiiApiSecret,
        },
        {
          timeout: 5000,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data.success) {
        console.log(`✅ Association réussie: ${phoneNumber} -> user ${userId}`);
        return response.data;
      } else {
        throw new Error(response.data.error || "Erreur association");
      }
    } catch (error) {
      console.error(`❌ Erreur association ${phoneNumber}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  // ... autres méthodes existantes (getSenderStatus, isClientHealthy, etc.)
  getSenderStatus(phoneNumber) {
    const state = this.clientStates.get(phoneNumber);
    if (!state) {
      return {
        status: "not_initialized",
        ready: false,
        authenticated: false,
        hasQR: false,
      };
    }
    return {
      status: state.ready ? "authenticated" : state.qr ? "qr_ready" : "waiting",
      ready: state.ready,
      authenticated: state.authenticated,
      hasQR: !!state.qr,
      lastActivity: state.lastActivity,
    };
  }

  async isClientHealthy(clientKey) {
    const state = this.clientStates.get(clientKey);
    if (!state) return false;
    const isFresh = Date.now() - state.lastActivity < SESSION_TIMEOUT;
    return state.ready && state.authenticated && isFresh;
  }

  updateSessionActivity(clientKey) {
    this.sessionQueue = this.sessionQueue.filter((id) => id !== clientKey);
    this.sessionQueue.push(clientKey);
    const state = this.clientStates.get(clientKey);
    if (state) {
      state.lastActivity = Date.now();
    }
  }

  async disconnectClient(phoneNumber) {
    const client = this.clients.get(phoneNumber);
    if (client) {
      try {
        await client.destroy();
        console.log(`🔒 [${phoneNumber}] Client déconnecté`);
      } catch (err) {
        console.error(`❌ Erreur déconnexion ${phoneNumber}:`, err.message);
      }
    }
    this.clients.delete(phoneNumber);
    this.clientStates.delete(phoneNumber);
    this.initializationLocks.delete(phoneNumber);
    this.qrGenerationLocks.delete(phoneNumber);
    this.sessionQueue = this.sessionQueue.filter((id) => id !== phoneNumber);
  }

  async deactivateOldestClient() {
    if (this.sessionQueue.length === 0) return;
    const oldestPhone = this.sessionQueue[0];
    console.log(`🧹 Désactivation client ancien: ${oldestPhone}`);
    await this.disconnectClient(oldestPhone);
  }

  async cleanupInactiveClients() {
    const now = Date.now();
    for (const [phoneNumber, state] of this.clientStates.entries()) {
      if (now - state.lastActivity > SESSION_TIMEOUT) {
        console.log(`🧹 Nettoyage client inactif: ${phoneNumber}`);
        await this.disconnectClient(phoneNumber);
      }
    }
    this.sessionQueue = this.sessionQueue.filter((phoneNumber) =>
      this.clientStates.has(phoneNumber)
    );
  }

  async createMediaFromAttachment(attachment) {
    const ext = attachment.type.split("/")[1] || "bin";
    const filename = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.${ext}`;
    const filePath = path.join(this.sessionPath, "temp", filename);

    if (!fs.existsSync(path.dirname(filePath))) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    const base64Data = attachment.data.replace(/^data:.+;base64,/, "");
    await fs.promises.writeFile(filePath, Buffer.from(base64Data, "base64"));

    const media = await MessageMedia.fromFilePath(filePath);
    fs.unlinkSync(filePath);

    return media;
  }

  getConnectedSenders() {
    const connectedSenders = [];
    for (const [phoneNumber, state] of this.clientStates.entries()) {
      if (state.ready && state.authenticated) {
        connectedSenders.push(phoneNumber);
      }
    }
    return connectedSenders;
  }

  getAllSessions() {
    const allSessions = [];
    for (const [phoneNumber, state] of this.clientStates.entries()) {
      allSessions.push({
        phoneNumber: phoneNumber,
        status: state.ready ? "authenticated" : state.qr ? "qr_ready" : "waiting",
        ready: state.ready,
        authenticated: state.authenticated,
        hasQR: !!state.qr,
        lastActivity: state.lastActivity,
      });
    }
    return allSessions;
  }

  getStats() {
    const readyClients = Array.from(this.clientStates.values()).filter(
      (state) => state.ready
    ).length;
    return {
      totalClients: this.clients.size,
      readyClients,
      authenticatedClients: readyClients,
      sessionQueueSize: this.sessionQueue.length,
      memoryUsage: process.memoryUsage(),
      maxActiveClients: MAX_ACTIVE_CLIENTS,
    };
  }

  async shutdown() {
    console.log("🛑 Arrêt gestionnaire WhatsApp...");
    for (const [phoneNumber] of this.clients) {
      await this.disconnectClient(phoneNumber);
    }
    console.log("✅ Arrêt terminé");
  }

  async debitQrCodeCount(phoneNumber) {
    try {
      console.log(`💰 [${phoneNumber}] Débit qrcode_count...`);
      const response = await axios.post(
        `${this.yiiApiUrl}/api/whatsapp-connected`,
        {
          user_id: phoneNumber,
          secret: this.yiiApiSecret,
        },
        {
          timeout: 5000,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
      if (response.data.success) {
        console.log(`✅ [${phoneNumber}] Compte débité avec succès`);
        return response.data;
      } else {
        throw new Error(response.data.error || "Erreur débit");
      }
    } catch (error) {
      console.error(`❌ [${phoneNumber}] Erreur API débit:`, error.message);
      return { success: false, error: error.message };
    }
  }
}

// Instance singleton
const clientManager = new WhatsAppClientManager();

// Fonctions utilitaires
function scanAllSessions() {
  return clientManager.getAllAvailableSessions();
}

async function loadSession(phoneNumber) {
  try {
    console.log(`🔄 Chargement session ${phoneNumber} en mémoire...`);
    const result = await clientManager.loadExistingSession(phoneNumber);
    return {
      success: true,
      phoneNumber: phoneNumber,
      client: result
    };
  } catch (error) {
    console.error(`❌ Erreur chargement ${phoneNumber}:`, error.message);
    throw error;
  }
}

async function loadSessionIntoMemory(phoneNumber) {
  try {
    console.log(`🔄 Chargement session ${phoneNumber} en mémoire...`);
    const result = await clientManager.generateNewQR(phoneNumber);
    return {
      success: true,
      phoneNumber: phoneNumber,
      status: result.status,
      ready: result.ready || false
    };
  } catch (error) {
    console.error(`❌ Erreur chargement ${phoneNumber}:`, error.message);
    return {
      success: false,
      phoneNumber: phoneNumber,
      error: error.message
    };
  }
}

// Gestion des signaux
process.on("SIGINT", async () => {
  await clientManager.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await clientManager.shutdown();
  process.exit(0);
});

// Export des fonctions
module.exports = {
  generateNewQR: (phoneNumber, userId) => clientManager.generateNewQR(phoneNumber, userId),
  sendMessage: (messageData) => clientManager.sendMessage(messageData),
  getSenderStatus: (phoneNumber) => clientManager.getSenderStatus(phoneNumber),
  getConnectedSenders: () => clientManager.getConnectedSenders(),
  disconnectClient: (phoneNumber) => clientManager.disconnectClient(phoneNumber),
  getStats: () => clientManager.getStats(),
  shutdown: () => clientManager.shutdown(),
  getAllSessions: () => clientManager.getAllSessions(),
  getAllAvailableSessions: () => clientManager.getAllAvailableSessions(),
  scanAllSessions,
  loadSessionIntoMemory,
  loadSession,
  Client,
  LocalAuth,
  Buttons,
  MessageMedia,
};