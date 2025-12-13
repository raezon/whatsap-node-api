const { Client, LocalAuth, Buttons, MessageMedia } = require("whatsapp-web.js");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const MAX_ACTIVE_CLIENTS = parseInt(process.env.MAX_ACTIVE_CLIENTS) || 10;
const SESSION_TIMEOUT = 30 * 60 * 1000;

// 📦 GESTIONNAIRE CLIENTS CORRIGÉ
class WhatsAppClientManager {
  constructor() {
    this.clients = new Map();
    this.clientStates = new Map();
    this.sessionPath = path.join(__dirname, "whatsapp-sessions");
    this.initializationLocks = new Map();
    this.qrGenerationLocks = new Map();
    this.sessionQueue = [];
    this.yiiApiUrl = process.env.YII_API_URL || "http://localhost:8080";
    this.yiiApiSecret = process.env.YII_API_SECRET || "my_very_secret_key_123";

    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }

    // 🔥 LOG REDUCED: De 5min à 15min pour moins de vérifications
    setInterval(() => this.cleanupInactiveClients(), 15 * 60 * 1000);

    // 🔥 PRÉ-CHARGEMENT DE CHROME
    this.preloadChrome();
  }

  /**
   * ⚡ Pré-charger Chrome pour accélérer les démarrages
   */
  async preloadChrome() {
    try {
      // Recherche silencieuse de Chrome
      const possiblePaths = [
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
      ];

      for (const chromePath of possiblePaths) {
        if (fs.existsSync(chromePath)) {
          this.chromePath = chromePath;
          break; // Premier trouvé
        }
      }
    } catch {
      // Silencieux en cas d'erreur
    }
  }

  /**
   * 🚀 Initialiser client (OPTIMISÉ)
   */
  async initializeClient(phoneNumber, userId = null) {
    const clientKey = phoneNumber;

    // 🔒 Lock optimisé avec timeout
    if (this.initializationLocks.has(clientKey)) {
      return this.waitForExistingClient(clientKey);
    }

    this.initializationLocks.set(clientKey, true);
    const startTime = Date.now();

    try {
      // Client existant et sain
      const existingClient = this.clients.get(clientKey);
      if (existingClient && (await this.isClientHealthy(clientKey))) {
        this.updateSessionActivity(clientKey);
        return existingClient;
      }

      // Gestion limite clients
      if (this.clients.size >= MAX_ACTIVE_CLIENTS) {
        await this.deactivateOldestClient();
      }

      // 🔥 OPTIONS PUPPETEER ULTRA-OPTIMISÉES
      const puppeteerOptions = {
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--single-process",
          "--no-zygote", // ⚡ DÉMARRAGE RAPIDE
          "--disable-extensions",
          "--disable-default-apps",
          "--mute-audio",
          "--disable-backgrounding-occluded-windows",
          "--disable-breakpad",
          "--disable-software-rasterizer",
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins",
        ],
        timeout: 10000, // ⚡ 10s max au lieu de 15s
        ignoreHTTPSErrors: true,
        dumpio: false,
      };

      if (this.chromePath) {
        puppeteerOptions.executablePath = this.chromePath;
      }

      // Nouveau client
      const client = new Client({
        authStrategy: new LocalAuth({
          clientId: phoneNumber,
          dataPath: this.sessionPath,
        }),
        puppeteer: puppeteerOptions,
        restartOnAuthFail: true,
        takeoverOnConflict: false, // ⚡ Désactivé pour performance
        qrMaxRetries: 2, // ⚡ Réduit de 3 à 2
        skipSignalsHandling: true, // Cette option peut exister selon la version
      });

      // État initial
      this.clientStates.set(clientKey, {
        ready: false,
        qr: null,
        authenticated: false,
        lastActivity: Date.now(),
        initialized: false,
        qrGenerated: false,
        debitDone: false,
      });

      // Handlers optimisés
      this.setupOptimizedEventHandlers(client, clientKey);

      // Initialisation avec timeout réduit
      await client.initialize();

      this.clientStates.get(clientKey).initialized = true;
      this.clients.set(clientKey, client);
      this.updateSessionActivity(clientKey);

      return client;
    } finally {
      // Libération rapide du lock
      setTimeout(() => this.initializationLocks.delete(clientKey), 500);
    }
  }

  getAllAvailableSessions() {
    const sessionsDir = this.sessionPath;
    const allSessions = [];

    try {
      if (fs.existsSync(sessionsDir)) {
        const folders = fs.readdirSync(sessionsDir);

        folders.forEach((folder) => {
          if (folder.startsWith("session-user_")) {
            const phoneNumber = folder.replace("session-", "");
            const state = this.clientStates.get(phoneNumber);
            const existsInMemory = this.clients.has(phoneNumber);

            allSessions.push({
              phoneNumber: phoneNumber,
              folderName: folder,
              existsInMemory: existsInMemory,
              ready: true,
              authenticated: state?.authenticated || false,
              hasQR: true,
              lastActivity: state?.lastActivity || null,
              status: state
                ? state.ready
                  ? "authenticated"
                  : state.qr
                  ? "qr_ready"
                  : "waiting"
                : "not_loaded",
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
   * ⚡ Attente client existant (OPTIMISÉ)
   */
  async waitForExistingClient(clientKey) {
    return new Promise((resolve) => {
      let checks = 0;
      const maxChecks = 10; // ⚡ 3 secondes max

      const checkInterval = setInterval(() => {
        checks++;
        const client = this.clients.get(clientKey);
        const state = this.clientStates.get(clientKey);

        if (client && state?.initialized) {
          clearInterval(checkInterval);
          resolve(client);
        } else if (checks >= maxChecks) {
          clearInterval(checkInterval);
          resolve(null); // Timeout
        }
      }, 300);
    });
  }

  /**
   * ⚡ Handlers événements optimisés (MOINS DE LOGS)
   */
  setupOptimizedEventHandlers(client, clientKey) {
    const state = this.clientStates.get(clientKey);

    // QR handler minimal
    client.once("qr", (qr) => {
      if (!state.qrGenerated) {
        state.qr = qr;
        state.qrGenerated = true;
        state.lastActivity = Date.now();
      }
    });

    // Ready handler optimisé
    client.once("ready", async () => {
      // Récupération numéro réel (silencieuse)
      let realPhoneNumber = null;

      if (client.info?.wid) {
        realPhoneNumber = client.info.wid.user;
      } else if (client.getMe) {
        try {
          const me = await client.getMe();
          realPhoneNumber = me?.id?.user || me?.id?._serialized?.split("@")[0];
        } catch {}
      }

      state.real_phone_number = realPhoneNumber;
      state.ready = true;
      state.authenticated = true;
      state.lastActivity = Date.now();
      console.log(`✅ [${clientKey}] WhatsApp prêt et authentifié.`);
      // Débit silencieux
      if (!state.debitDone) {
        state.debitDone = true;
        this.debitQrCodeCount(clientKey, realPhoneNumber || null).catch(
          () => {}
        );
      }
    });

    // Error handlers (logs réduits)
    client.on("auth_failure", () => {
      state.qrGenerated = false;
    });

    client.on("disconnected", () => {
      state.ready = false;
      state.authenticated = false;
      state.qrGenerated = false;
    });
  }

  /**
   * ⚡ Génération QR optimisée
   */
  async generateNewQR(phoneNumber, userId = null) {
    // Éviter les doublons
    if (this.qrGenerationLocks.has(phoneNumber)) {
      return this.waitForExistingQR(phoneNumber);
    }

    this.qrGenerationLocks.set(phoneNumber, true);
    const startTime = Date.now();

    try {
      const state = this.clientStates.get(phoneNumber);

      // Vérifications rapides
      if (state?.ready && state?.authenticated) {
        if (userId) await this.associatePhoneWithUser(userId, phoneNumber);
        return { status: "authenticated", ready: true };
      }

      if (state?.qr) {
        if (userId) await this.associatePhoneWithUser(userId, phoneNumber);
        return { qr: state.qr, status: "qr_ready", ready: false };
      }

      // Initialisation client
      await this.initializeClient(phoneNumber, userId);
      if (userId) await this.associatePhoneWithUser(userId, phoneNumber);

      // Attente QR avec timeout réduit
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("QR timeout"));
        }, 15000); // ⚡ 15s au lieu de 30s

        let checks = 0;
        const checkInterval = setInterval(() => {
          checks++;
          const currentState = this.clientStates.get(phoneNumber);

          if (currentState?.qr) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve({
              qr: currentState.qr,
              status: "qr_ready",
              ready: false,
            });
          } else if (currentState?.ready) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve({
              status: "authenticated",
              ready: true,
            });
          } else if (checks > 30) {
            // ⚡ 30 checks max
            clearInterval(checkInterval);
            clearTimeout(timeout);
            reject(new Error("Max checks reached"));
          }
        }, 500); // ⚡ Vérification toutes les 500ms
      });
    } catch (error) {
      throw error;
    } finally {
      setTimeout(() => {
        this.qrGenerationLocks.delete(phoneNumber);
      }, 1000);
    }
  }

  async generateNewQRPhone(phoneNumber, userId = null) {
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
            console.log(
              `✅ [${phoneNumber}] QR généré avec succès pour user xx ${userId}`
            );
            resolve({
              qr: currentState.qr,
              status: "qr_ready",
              ready: false,
              message: "Scannez ce QR avec WhatsApp",
            });
          } else if (currentState && currentState.ready) {
            clearTimeout(timeout);
            console.log(
              `✅ [${phoneNumber}] Déjà authentifié pendant l'attente`
            );
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
   * ⚡ Attente QR existant
   */
  async waitForExistingQR(phoneNumber) {
    return new Promise((resolve) => {
      let checks = 0;

      const checkInterval = setInterval(() => {
        checks++;
        const state = this.clientStates.get(phoneNumber);

        if (state?.qr) {
          clearInterval(checkInterval);
          resolve({
            qr: state.qr,
            status: "qr_ready",
            ready: false,
            message: "QR déjà disponible",
          });
        } else if (state?.ready) {
          clearInterval(checkInterval);
          resolve({
            status: "authenticated",
            message: "Déjà authentifié",
            ready: true,
          });
        } else if (checks > 20) {
          // 10 secondes max
          clearInterval(checkInterval);
          resolve({ status: "timeout", ready: false });
        }
      }, 500);
    });
  }

  /**
   * ⚡ Envoi message optimisé
   */
  async sendMessage(messageData) {
    const { to, text, attachments, from } = messageData;
    const clientKey = from;

    try {
      // Client check optimisé
      if (
        !this.clients.has(clientKey) ||
        !(await this.isClientHealthy(clientKey))
      ) {
        await this.initializeClient(from);
      }

      const client = this.clients.get(clientKey);
      if (!client) throw new Error(`Client non disponible`);

      const state = this.clientStates.get(clientKey);
      if (!state?.ready || !state?.authenticated) {
        throw new Error(`WhatsApp non connecté`);
      }

      // Vérification numéro
      const numberDetails = await client.getNumberId(to);
      if (!numberDetails) {
        return {
          success: false,
          to,
          from,
          skipped: true,
          reason: "Numéro non enregistré",
          timestamp: new Date().toISOString(),
        };
      }

      const chatId = numberDetails._serialized;
      let messageResult;

      // Envoi selon type
      if (attachments?.length > 0) {
        for (const attachment of attachments) {
          const media = await this.createMediaFromAttachment(attachment);
          messageResult = await client.sendMessage(chatId, media, {
            caption: text,
          });
        }
      } else if (text) {
        messageResult = await client.sendMessage(chatId, text);
      } else {
        throw new Error("Aucun contenu à envoyer");
      }

      this.updateSessionActivity(clientKey);

      return {
        success: true,
        to,
        from,
        messageId: messageResult?.id?._serialized,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(`Échec envoi: ${error.message}`);
    }
  }

  /**
   * ⚡ Débit optimisé (silencieux)
   */
  async debitQrCodeCount(clientId, phoneNumber) {
    try {
      const userId = this.extractUserIdFromPhone(clientId);

      if (!userId) return { success: false, error: "User ID non trouvé" };
      console.log(`💸 Débit QR dz pour user ${userId}, client ${clientId}...`);
      const response = await axios.post(
        `${this.yiiApiUrl}/api/whatsapp-connected`,
        `user_id=${userId}&secret=${encodeURIComponent(
          this.yiiApiSecret
        )}&phone_number=${encodeURIComponent(
          phoneNumber || ""
        )}&clientId=${encodeURIComponent(clientId)}`, // Changed from client_id to clientId
        {
          timeout: 3000, // ⚡ 3s max
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }
      );
    
      return response.data.success
        ? { success: true }
        : { success: false, error: response.data.error };
    } catch (error) {
      return { success: false, error: "Erreur réseau" };
    }
  }

  // ⚡ MÉTHODES RESTANTES OPTIMISÉES (logs réduits)

  async associatePhoneWithUser(userId, phoneNumber) {
    try {
      const response = await axios.post(
        `${this.yiiApiUrl}/api/whatsapp-connected`,
        {
          user_id: userId,
          phone_number: phoneNumber,
          secret: this.yiiApiSecret,
        },
        { timeout: 3000, headers: { "Content-Type": "application/json" } }
      );
      return response.data;
    } catch {
      return { success: false, error: "Association échouée" };
    }
  }

  getSenderStatus(phoneNumber) {
    const state = this.clientStates.get(phoneNumber);
    return state
      ? {
          status: state.ready
            ? "authenticated"
            : state.qr
            ? "qr_ready"
            : "waiting",
          ready: state.ready,
          authenticated: state.authenticated,
          hasQR: !!state.qr,
          lastActivity: state.lastActivity,
        }
      : {
          status: "not_initialized",
          ready: false,
          authenticated: false,
          hasQR: false,
          lastActivity: null,
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
    if (state) state.lastActivity = Date.now();
  }

  async disconnectClient(phoneNumber) {
    const client = this.clients.get(phoneNumber);
    if (client) {
      try {
        await client.destroy();
      } catch {}
    }
    this.clients.delete(phoneNumber);
    this.clientStates.delete(phoneNumber);
    this.initializationLocks.delete(phoneNumber);
    this.qrGenerationLocks.delete(phoneNumber);
    this.sessionQueue = this.sessionQueue.filter((id) => id !== phoneNumber);
  }

  async deactivateOldestClient() {
    if (this.sessionQueue.length === 0) return;
    await this.disconnectClient(this.sessionQueue[0]);
  }

  async cleanupInactiveClients() {
    const now = Date.now();
    for (const [phoneNumber, state] of this.clientStates.entries()) {
      if (now - state.lastActivity > SESSION_TIMEOUT) {
        await this.disconnectClient(phoneNumber);
      }
    }
    this.sessionQueue = this.sessionQueue.filter((phoneNumber) =>
      this.clientStates.has(phoneNumber)
    );
  }

  async createMediaFromAttachment(attachment) {
    const ext = attachment.type.split("/")[1] || "bin";
    const filename = `temp_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}.${ext}`;
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
    return Array.from(this.clientStates.entries())
      .filter(([_, state]) => state.ready && state.authenticated)
      .map(([phoneNumber]) => phoneNumber);
  }

  getAllSessions() {
    return Array.from(this.clientStates.entries()).map(
      ([phoneNumber, state]) => ({
        phoneNumber,
        status: state.ready
          ? "authenticated"
          : state.qr
          ? "qr_ready"
          : "waiting",
        ready: state.ready,
        authenticated: state.authenticated,
        hasQR: !!state.qr,
        lastActivity: state.lastActivity,
      })
    );
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
      maxActiveClients: MAX_ACTIVE_CLIENTS,
    };
  }

  async shutdown() {
    for (const [phoneNumber] of this.clients) {
      await this.disconnectClient(phoneNumber);
    }
  }

  extractUserIdFromPhone(phoneNumber) {
    const match = phoneNumber.match(/user_(\d+)_/);
    return match ? parseInt(match[1]) : null;
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
      client: result,
    };
  } catch (error) {
    console.error(`❌ Erreur chargement ${phoneNumber}:`, error.message);
    throw error;
  }
}

async function loadSessionBySession(sessionName) {
      console.log(`🔄 Chargement de la session nommée: ${sessionName}...`);
  try {
    console.log(`🔄 Chargement de la session nommée: ${sessionName}...`);
    
    // Vérifier d'abord si c'est déjà en mémoire
    const currentStatus = clientManager.getSenderStatus(sessionName);
    
    if (currentStatus.ready && currentStatus.authenticated) {
      console.log(`✅ Session ${sessionName} déjà connectée en mémoire`);
      return {
        success: true,
        sessionName: sessionName,
        status: "authenticated",
        ready: true,
        alreadyConnected: true
      };
    }
    
    // Vérifier si une session existe sur le disque
    const allSessions = clientManager.getAllAvailableSessions();
    const sessionExistsOnDisk = allSessions.some(s => s.folderName === `session-${sessionName}`);
    
    if (!sessionExistsOnDisk) {
      console.log(`⚠️ Session ${sessionName} n'existe pas sur le disque`);
      
      // Générer une NOUVELLE session avec ce nom
      const qrResult = await clientManager.generateNewQRPhone(sessionName);
      
      return {
        success: true,
        sessionName: sessionName,
        status: qrResult.status,
        qrCode: qrResult.qr,
        ready: qrResult.ready || false,
        message: "Nouvelle session créée, scannez le QR code",
        isNewSession: true
      };
    }
    
    // Session existe sur disque mais pas en mémoire
    console.log(`📂 Session ${sessionName} existe sur disque, chargement...`);
    
    // Utiliser generateNewQRPhone qui gère le chargement automatique
    const qrResult = await clientManager.generateNewQRPhone(sessionName);
    
    return {
      success: true,
      sessionName: sessionName,
      status: qrResult.status,
      qrCode: qrResult.qr,
      ready: qrResult.ready || false,
      message: qrResult.message,
      loadedFromDisk: true
    };
    
  } catch (error) {
    console.error(`❌ Erreur chargement session ${sessionName}:`, error.message);
    
    // Si erreur de connexion, offrir un QR code comme alternative
    try {
      const qrResult = await clientManager.generateNewQRPhone(sessionName);
      
      return {
        success: false,
        sessionName: sessionName,
        error: `Chargement échoué mais QR disponible: ${error.message}`,
        fallbackQR: qrResult.qr,
        status: qrResult.status,
        ready: false
      };
    } catch (qrError) {
      throw new Error(`Impossible de charger ou créer session ${sessionName}: ${error.message}`);
    }
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
      ready: result.ready || false,
    };
  } catch (error) {
    console.error(`❌ Erreur chargement ${phoneNumber}:`, error.message);
    return {
      success: false,
      phoneNumber: phoneNumber,
      error: error.message,
    };
  }
}

// 🎯 CORRECTION DUPLICATA
//process.removeAllListeners("SIGINT");
//process.removeAllListeners("SIGTERM");

// Gestion des signaux (votre code existant reste inchangé)
process.on("SIGINT", async () => {
  await clientManager.shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await clientManager.shutdown();
  process.exit(0);
});

// ✅ CORRECTION: Export propre avec toutes les fonctions
module.exports = {
  // Export de l'instance principale (utile pour le debug)
  clientManager,

  // Méthodes principales bindées
  generateNewQR: (phoneNumber, userId) =>
    clientManager.generateNewQR(phoneNumber, userId),
  generateNewQRPhone: (phoneNumber, userId) =>
    clientManager.generateNewQRPhone(phoneNumber, userId),
  sendMessage: (messageData) => clientManager.sendMessage(messageData),
  getSenderStatus: (phoneNumber) => clientManager.getSenderStatus(phoneNumber),
  getConnectedSenders: () => clientManager.getConnectedSenders(),
  disconnectClient: (phoneNumber) =>
    clientManager.disconnectClient(phoneNumber),
  getStats: () => clientManager.getStats(),
  shutdown: () => clientManager.shutdown(),
  getAllSessions: () => clientManager.getAllSessions(),
  getAllAvailableSessions: () => clientManager.getAllAvailableSessions(),

  // Fonctions utilitaires
  scanAllSessions,
  loadSessionIntoMemory,
  loadSession,
  loadSessionBySession,

  // Classes WhatsApp
  Client,
  LocalAuth,
  Buttons,
  MessageMedia,
};
