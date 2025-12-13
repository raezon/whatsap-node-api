const { Client, LocalAuth, Buttons, MessageMedia } = require("whatsapp-web.js");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

// Chemin du fichier de sauvegarde
const AUTH_STATE_FILE = path.join(__dirname, "authState.json");

// Charger l'état au démarrage
let authState = new Map();

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

    // 🔒 Si un client est déjà en cours d'initialisation → on attend
    if (this.initializationLocks.has(clientKey)) {
      console.log(`⏳ [${phoneNumber}] Initialisation déjà en cours...`);

      return new Promise((resolve) => {
        const waitForInit = () => {
          const client = this.clients.get(clientKey);
          const state = this.clientStates.get(clientKey);

          if (client && state?.initialized) {
            resolve(client);
          } else {
            setTimeout(waitForInit, 300);
          }
        };
        waitForInit();
      });
    }

    // Marquage pour éviter double init
    this.initializationLocks.set(clientKey, true);

    try {
      // 🟢 Vérification du client existant
      const existingClient = this.clients.get(clientKey);

      if (existingClient && (await this.isClientHealthy(clientKey))) {
        console.log(`♻️ [${phoneNumber}] Client actif réutilisé`);
        this.updateSessionActivity(clientKey);
        return existingClient;
      }

      // 🔥 Trop de clients actifs ? → on en désactive un
      if (this.clients.size >= MAX_ACTIVE_CLIENTS) {
        await this.deactivateOldestClient();
      }

      console.log(
        `🆕 [${phoneNumber}] Création d'un nouveau client WhatsApp...`
      );
  // ✅ Configuration Puppeteer corrigée
      const puppeteerOptions = {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--single-process",
          "--disable-gpu",
          "--disable-web-security",
          "--disable-features=site-per-process",
          "--disable-ipc-flooding-protection",
          "--disable-renderer-backgrounding",
          "--disable-background-timer-throttling",
          "--disable-client-side-phishing-detection",
          "--disable-default-apps",
          "--disable-extensions",
          "--disable-hang-monitor",
          "--disable-prompt-on-repost",
          "--disable-sync",
          "--disable-translate",
          "--metrics-recording-only",
          "--safebrowsing-disable-auto-update",
          "--disable-backgrounding-occluded-windows",
          "--disable-breakpad",
          "--disable-component-extensions-with-background-pages",
          "--disable-software-rasterizer",
          "--mute-audio"
        ],
        ignoreHTTPSErrors: true,
      };

      // ✅ Add Chrome executable path if found
      if (this.chromePath) {
        puppeteerOptions.executablePath = this.chromePath;
      }

      // 🆕 Nouveau client
      const client = new Client({
        authStrategy: new LocalAuth({
          clientId: phoneNumber,
          dataPath: this.sessionPath,
        }),
        puppeteer: puppeteerOptions,
        restartOnAuthFail: true,
        takeoverOnConflict: true,
        qrMaxRetries: 3,
      });
      // 🗄️ État interne
      this.clientStates.set(clientKey, {
        ready: false,
        qr: null,
        authenticated: false,
        lastActivity: Date.now(),
        initialized: false,
        qrGenerated: false,
      });

      // 📡 Écouteurs d'événements
      this.setupEventHandlers(client, clientKey);

      // 🚀 Initialisation du client
      await client.initialize();

      // Le client est maintenant officiellement prêt à être utilisé
      this.clientStates.get(clientKey).initialized = true;

      // On enregistre ce client
      this.clients.set(clientKey, client);
      this.updateSessionActivity(clientKey);

      return client;
    } finally {
      // Libère le lock après un court délai
      setTimeout(() => this.initializationLocks.delete(clientKey), 1500);
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
      // 🆕 Marquer que c'est une NOUVELLE session
      state.debitDone = false;
    });

    async function loadAuthState() {
      try {
        const data = await fs.readFile(AUTH_STATE_FILE, "utf8");
        const saved = JSON.parse(data);
        authState = new Map(Object.entries(saved));
        console.log("✅ État auth chargé:", Array.from(authState.keys()));
      } catch (error) {
        if (error.code === "ENOENT") {
          await fs.writeFile(AUTH_STATE_FILE, "{}");
          console.log("📁 Fichier authState.json créé");
        } else {
          console.error("❌ Erreur chargement authState:", error.message);
        }
      }
    }

    async function saveAuthState() {
      try {
        const data = JSON.stringify(Object.fromEntries(authState), null, 2);
        await fs.writeFile(AUTH_STATE_FILE, data);
      } catch (error) {
        console.error("❌ Erreur sauvegarde authState:", error.message);
      }
    }

    // Charger l'état au début
    loadAuthState();

    // VOTRE ÉVÉNEMENT AUTHENTIFIED MODIFIÉ
    client.on("authenticated", async () => {
      if (!state.debitDone) {
        state.debitDone = true;
        console.log(
          `💰 [${clientKey}] Première authentification - Débit du QR code`
        );
        this.debitQrCodeCount(clientKey).catch((err) => {
          console.error(`❌ [${clientKey}] Erreur débit:`, err.message);
        });
      } else {
        console.log(
          `🔄 [${clientKey}] Reconnexion - Pas de débit (déjà débité)`
        );
      }
      console.log(`🔐 [${clientKey}] Authentifié - QR SCANNÉ!`);
      state.authenticated = true;
      state.lastActivity = Date.now();
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
        state.debitDone = true;
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
              `✅ [${phoneNumber}] QR généré avec succès pour user x ${userId}`
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
   * 📨 ENVOYER MESSAGE - CORRIGÉ
   */
  /**
   * 📨 ENVOYER MESSAGE - CORRIGÉ ET COMPLET
   */
  async sendMessage(messageData) {
    const { to, text, attachments, from } = messageData;
    const clientKey = from;

    console.log(`📩 Envoi message à ${to} depuis ${clientKey}...`);

    try {
      // ✅ Vérifier et initialiser le client si nécessaire
      if (
        !this.clients.has(clientKey) ||
        !(await this.isClientHealthy(clientKey))
      ) {
        console.log(`🔄 Client ${clientKey} non trouvé, initialisation...`);
        await this.initializeClient(from);
      }

      // ✅ Vérifier à nouveau après initialisation
      if (!this.clients.has(clientKey)) {
        throw new Error(
          `Client ${clientKey} non disponible après initialisation`
        );
      }

      const client = this.clients.get(clientKey);

      if (!client) {
        throw new Error(`Client WhatsApp non disponible pour ${from}`);
      }

      // Vérifier si le client est prêt
      const state = this.clientStates.get(clientKey);
      if (!state || !state.ready || !state.authenticated) {
        throw new Error(
          `WhatsApp non connecté sur ${from}. Statut: ${
            state?.status || "non initialisé"
          }`
        );
      }

      console.log(`✅ Client ${clientKey} prêt, envoi du message...`);

      // ✅ FORMATER LE NUMÉRO (TRÈS IMPORTANT)
      const formattedTo = to;
      console.log(`🔍 Numéro formaté: ${to} → ${formattedTo}`);

      // ✅ VÉRIFIER LE NUMÉRO SUR WHATSAPP
      console.log(`🔍 Vérification numéro ${formattedTo} sur WhatsApp...`);
      const numberDetails = await client.getNumberId(formattedTo);
      console.log(
        `✅ Détails du numéro obtenus:`,
        numberDetails ? "Numéro valide" : "Numéro invalide"
      );

      if (!numberDetails) {
        console.log(
          `⚠️ Numéro ${formattedTo} non enregistré sur WhatsApp, ignoré`
        );
        return {
          success: false,
          to: formattedTo,
          from,
          skipped: true,
          reason: "Numéro non enregistré sur WhatsApp",
          timestamp: new Date().toISOString(),
        };
      }

      const chatId = numberDetails._serialized;
      console.log(`💬 Chat ID: ${chatId}`);

      // ✅ ENVOYER LE MESSAGE
      let messageResult;

      if (attachments && Array.isArray(attachments) && attachments.length > 0) {
        console.log(`📎 Envoi avec ${attachments.length} pièce(s) jointe(s)`);
        for (const attachment of attachments) {
          const media = await this.createMediaFromAttachment(attachment);
          messageResult = await client.sendMessage(chatId, media, {
            caption: text,
          });
          console.log(`✅ Fichier envoyé: ${attachment.name || "sans nom"}`);
        }
      } else if (text) {
        console.log(
          `📝 Envoi texte: "${text.substring(0, 50)}${
            text.length > 50 ? "..." : ""
          }"`
        );
        messageResult = await client.sendMessage(chatId, text);
      } else {
        throw new Error(
          "Aucun contenu à envoyer (texte ou pièces jointes requis)"
        );
      }

      // ✅ CONFIRMATION
      this.updateSessionActivity(clientKey);
      console.log(
        `✅ Message envoyé avec succès à ${formattedTo} depuis ${from}`
      );

      if (messageResult) {
        console.log(`📨 ID du message: ${messageResult.id._serialized}`);
      }

      return {
        success: true,
        to: formattedTo,
        from,
        messageId: messageResult?.id?._serialized,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error(
        `❌ Erreur envoi message de ${from} vers ${to}:`,
        error.message
      );

      // Relancer l'erreur avec plus de détails
      throw new Error(`Échec envoi: ${error.message}`);
    }
  }

  /**
   * 🆕 MÉTHODE POUR FORMATER LES NUMÉROS
   */
  formatPhoneNumber(phone) {
    if (!phone) {
      throw new Error("Numéro vide");
    }

    // Supprimer tous les caractères non numériques sauf le +
    let cleaned = phone.replace(/[^\d+]/g, "");

    // Si le numéro commence par 0, remplacer par l'indicatif Maroc
    if (cleaned.startsWith("0")) {
      cleaned = "+212" + cleaned.substring(1);
    }
    // Si le numéro commence par 6 ou 7 sans indicatif
    else if (cleaned.match(/^[67]\d{8}$/)) {
      cleaned = "+212" + cleaned;
    }
    // Si le numéro a l'indicatif sans +
    else if (cleaned.startsWith("212")) {
      cleaned = "+" + cleaned;
    }
    // Si le numéro n'a pas de +
    else if (cleaned.match(/^\d{9,15}$/) && !cleaned.startsWith("+")) {
      cleaned = "+" + cleaned;
    }

    // Vérifier le format final
    if (!cleaned.match(/^\+\d{10,15}$/)) {
      throw new Error(
        `Format de numéro invalide: ${phone} → ${cleaned}. Format attendu: +212612345678`
      );
    }

    return cleaned;
  }

  /**
   * 🆕 CHARGER UNE SESSION EXISTANTE
   */
  async loadExistingSession(phoneNumber) {
    const clientKey = phoneNumber;

    if (
      this.clients.has(clientKey) &&
      (await this.isClientHealthy(clientKey))
    ) {
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
   * 🆕 ASSOCIER UN NUMÉRO À UN UTILISATEUR
   */
  async associatePhoneWithUser(userId, phoneNumber) {
    try {
      console.log(`🔗 Association ${phoneNumber} avec user ${userId}`);

      const response = await axios.post(
        `${this.yiiApiUrl}/api/whatsapp-connected`,
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

  getSenderStatus(phoneNumber) {
    const state = this.clientStates.get(phoneNumber);
    if (!state) {
      return {
        status: "not_initialized",
        ready: false,
        authenticated: false,
        hasQR: false,
        lastActivity: null,
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
        status: state.ready
          ? "authenticated"
          : state.qr
          ? "qr_ready"
          : "waiting",
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

      // 🆕 Extraire l'user_id du numéro virtuel
      let userId = this.extractUserIdFromPhone(phoneNumber);
      console.log(`🔍 [${phoneNumber}] ID utilisateur extrait: ${userId}`);
      console.log(`${this.yiiApiUrl}/api/whatsapp-connected`);
      const response = await axios.post(
        `${this.yiiApiUrl}/api/whatsapp-connected`,
        `user_id=${userId}&secret=${encodeURIComponent(this.yiiApiSecret)}`,
        {
          timeout: 5000,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded", // 🆕
          },
        }
      );
      if (response.data.success) {
        console.log(
          `✅ [${phoneNumber}] Compte débité avec succès pour user ${userId}`
        );
        return response.data;
      } else {
        throw new Error(response.data.error || "Erreur débit");
      }
    } catch (error) {
      console.error(`❌ [${phoneNumber}] Erreur API débit:`, error.message);
      // 🆕 Afficher plus de détails
      if (error.response) {
        console.error(`📊 Status: ${error.response.status}`);
        console.error(`📊 Data:`, error.response.data);
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * 🆕 Extraire l'ID utilisateur du numéro virtuel
   */
  extractUserIdFromPhone(phoneNumber) {
    // Format: "user_15_1763581264874" → extraire "15"
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

// Gestion des signaux
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

  // Classes WhatsApp
  Client,
  LocalAuth,
  Buttons,
  MessageMedia,
};
