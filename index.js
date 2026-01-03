const express = require("express");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const fs = require("fs");
const axios = require("axios");
const path = require("path");
const {
  generateNewQR,
  generateNewQRPhone,
  sendMessage,
  getSenderStatus,
  getConnectedSenders,
  disconnectClient,
  getAllSessions,
  scanAllSessions,
  getStats,
  Buttons,
  loadSession,
  loadSessionBySession,
  MessageMedia,
  clientManager
} = require("./client");

const app = express();
const PORT = process.env.PORT || 4000;
const MAX_REQUESTS_PER_MINUTE =
  parseInt(process.env.MAX_REQUESTS_PER_MINUTE) || 1000;

// Middleware
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// Rate limiting
const requestCounts = new Map();
setInterval(() => requestCounts.clear(), 60000);

const rateLimit = (req, res, next) => {
  const ip = req.ip;
  const count = requestCounts.get(ip) || 0;

  if (count >= MAX_REQUESTS_PER_MINUTE) {
    return res.status(429).json({ error: "Too many requests", retryAfter: 60 });
  }

  requestCounts.set(ip, count + 1);
  next();
};

app.use(rateLimit);

// Dossier uploads
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Nettoyage fichiers temporaires
setInterval(() => {
  const files = fs.readdirSync(uploadsDir);
  const now = Date.now();
  const MAX_AGE = 3600000;

  files.forEach((file) => {
    const filePath = path.join(uploadsDir, file);
    try {
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > MAX_AGE) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      // Fichier en cours d'utilisation
    }
  });
}, 3600000);

// File d'attente par user ID
const userQueues = new Map();
const MAX_CONCURRENT_PER_USER = 3;

const queueUserRequest = (userId, operation) => {
  return new Promise((resolve, reject) => {
    if (!userQueues.has(userId)) {
      userQueues.set(userId, []);
    }

    const queue = userQueues.get(userId);
    queue.push({ operation, resolve, reject });

    if (queue.length === 1) {
      processUserQueue(userId);
    }
  });
};

const processUserQueue = async (userId) => {
  const queue = userQueues.get(userId);
  if (!queue || queue.length === 0) {
    userQueues.delete(userId);
    return;
  }

  const batch = queue.splice(
    0,
    Math.min(MAX_CONCURRENT_PER_USER, queue.length)
  );

  const batchPromises = batch.map(async ({ operation, resolve, reject }) => {
    try {
      const result = await operation();
      resolve(result);
    } catch (error) {
      reject(error);
    }
  });

  await Promise.all(batchPromises);

  if (queue.length > 0) {
    processUserQueue(userId);
  } else {
    userQueues.delete(userId);
  }
};

// 🆕 Stockage des associations user_id -> phone_numbers
const userPhoneMap = new Map(); // user_id -> [phone_numbers]

// 🆕 Configuration API Yii
const YII_API_URL = process.env.YII_API_URL || "http://localhost:8080";
const YII_API_SECRET = process.env.YII_API_SECRET || "my_very_secret_key_123";

// Middleware de logging

app.use((req, res, next) => {
const allowedOrigins = [
  "http://13.38.17.55:8080", // VOTRE FRONTEND
  "http://13.38.17.55:4000", // VOTRE API  
  "https://13.38.17.55:8080",
  "https://13.38.17.55:4000",
  "http://localhost:8080",
  "http://localhost:3000",
  "http://localhost:4000",
  "http://148.230.116.113:8000",
  "http://148.230.116.113:4000",
  "https://148.230.116.113:8000",
  "https://148.230.116.113:4000", 
  "https://tickets.voyage-test.xyz",
  "http://tickets.voyage-test.xyz"
];
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-CSRF-Token"
  );
  res.header("Access-Control-Allow-Credentials", "true");

  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// -----------------------------
// 🆕 ROUTES BASÉES SUR USER ID
// -----------------------------

// Route de debug complète
app.get("/debug/all-sessions", (req, res) => {
  try {
    const allSessions = getAllSessions();
    const connectedSenders = getConnectedSenders();

    res.json({
      all_sessions_count: allSessions.length,
      connected_senders_count: connectedSenders.length,
      all_sessions: allSessions,
      connected_senders: connectedSenders,
      user_phone_map: Object.fromEntries(userPhoneMap),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🆕 ROUTE POUR DIAGNOSTIC COMPLET
app.get("/debug/system-state", (req, res) => {
  const sessionsDir = path.join(__dirname, "whatsapp-sessions");
  let diskSessions = [];

  try {
    if (fs.existsSync(sessionsDir)) {
      diskSessions = fs
        .readdirSync(sessionsDir)
        .filter((folder) => folder.startsWith("user_"));
    }
  } catch (error) {
    console.error("❌ Erreur lecture dossier sessions:", error);
  }

  const allSessions = scanAllSessions();
  const connectedSenders = getConnectedSenders();

  res.json({
    system: {
      sessions_directory: sessionsDir,
      directory_exists: fs.existsSync(sessionsDir),
    },
    disk: {
      total_sessions: diskSessions.length,
      sessions: diskSessions,
    },
    memory: {
      all_sessions_count: allSessions.length,
      all_sessions: allSessions,
      connected_senders_count: connectedSenders.length,
      connected_senders: connectedSenders,
    },
    cache: {
      user_phone_map: Object.fromEntries(userPhoneMap),
      user_phone_map_size: userPhoneMap.size,
    },
    timestamp: new Date().toISOString(),
  });
});
// 1️⃣ GÉNÉRER QR CODE POUR UN USER (génère un nouveau numéro à chaque fois)
app.get("/user/:userId/generate-qr", async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await queueUserRequest(userId, async () => {
      console.log(`🎯 Demande QR pour user ${userId}`);

      // 🆕 D'ABORD VÉRIFIER SI L'UTILISATEUR A DÉJÀ UNE SESSION
      const allSessions = scanAllSessions();
      const userSessions = allSessions.filter((session) =>
        session.phoneNumber.includes(`user_${userId}_`)
      );

      // 🆕 FILTRER SEULEMENT LES SESSIONS VALIDES (pas empty_folder)
      const validSessions = userSessions.filter(session => 
        session.status !== "empty_folder" && session.status !== "not_initialized"
      );

      let existingPhoneNumber = null;
      let existingSessionStatus = null;

      if (validSessions.length > 0) {
        // 🆕 TROUVER LA SESSION LA PLUS RÉCENTE
        const latestSession = validSessions.sort((a, b) => {
          const getTimestamp = (phone) => {
            const match = phone.match(/_(\d+)$/);
            return match ? parseInt(match[1]) : 0;
          };
          return getTimestamp(b.phoneNumber) - getTimestamp(a.phoneNumber);
        })[0];

        existingPhoneNumber = latestSession.phoneNumber;
        existingSessionStatus = latestSession.status;

        console.log(`📱 Utilisateur ${userId} a déjà une session: ${existingPhoneNumber}`);
        console.log(`📊 Statut de la session: ${existingSessionStatus}`);
      }

      // 🆕 CAS 1 : UTILISATEUR A DÉJÀ UNE SESSION AUTHENTIFIÉE
      if (existingPhoneNumber && (existingSessionStatus === "authenticated" || existingSessionStatus === "qr_ready")) {
        console.log(`🔄 Récupération de la session existante: ${existingPhoneNumber}`);
        
        // Récupérer le statut actuel
        const currentStatus = getSenderStatus(existingPhoneNumber);
        
        if (currentStatus.ready && currentStatus.authenticated) {
          // Session déjà prête et authentifiée
          return {
            status: "authenticated",
            message: `WhatsApp déjà connecté sur cette session`,
            ready: true,
            user_id: userId,
            phone_number: existingPhoneNumber,
            session_already_exists: true,
          };
        } else if (currentStatus.hasQR) {
          // Session avec QR en attente
          console.log(`📱 QR déjà disponible pour ${existingPhoneNumber}`);
          
          // Charger la session en mémoire si pas déjà fait
          if (!clientManager.clients.get(existingPhoneNumber)) {
            console.log(`📥 Chargement session existante en mémoire...`);
            await generateNewQRPhone(existingPhoneNumber);
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          
          // Récupérer le QR
          const qrResult = await generateNewQR(existingPhoneNumber, userId);
          
          if (qrResult.qr) {
            const qrImage = await QRCode.toDataURL(qrResult.qr);
            return {
              status: "qr_ready",
              qrImage: qrImage,
              qrRaw: qrResult.qr,
              message: `Scannez ce QR pour connecter votre session WhatsApp`,
              ready: false,
              user_id: userId,
              phone_number: existingPhoneNumber,
              session_already_exists: true,
            };
          }
        }
      }

      // 🆕 CAS 2 : UTILISATEUR N'A PAS DE SESSION OU SESSION INVALIDE
      // Générer un nouveau numéro
      const phoneNumber = `user_${userId}_${Date.now()}`;
      console.log(`🆕 Création nouvelle session: ${phoneNumber}`);

      // Générer le QR Code
      const qrResult = await generateNewQR(phoneNumber, userId);

      if (qrResult.status === "authenticated") {
        return {
          status: "authenticated",
          message: `WhatsApp déjà connecté sur cette session`,
          ready: true,
          user_id: userId,
          phone_number: phoneNumber,
          session_already_exists: false,
        };
      }

      // Générer l'image QR
      const qrImage = await QRCode.toDataURL(qrResult.qr);

      // Associer ce numéro à l'utilisateur
      await associatePhoneWithUser(userId, phoneNumber);

      return {
        status: "qr_ready",
        qrImage: qrImage,
        qrRaw: qrResult.qr,
        message: `Scannez ce QR pour connecter une nouvelle session WhatsApp`,
        ready: false,
        user_id: userId,
        phone_number: phoneNumber,
        session_already_exists: false,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(`❌ Erreur QR pour user ${userId}:`, err.message);
    res.status(500).json({
      error: err.message,
      status: "error",
      user_id: userId,
      suggestion: "Réessayez dans 10 secondes",
    });
  }
});

// Route simple pour vérifier les handlers de signaux
app.get("/debug/signal-handlers", (req, res) => {
  const criticalSignals = ['SIGINT', 'SIGTERM', 'SIGUSR1', 'SIGUSR2'];
  
  const handlers = {};
  
  criticalSignals.forEach(signal => {
    const listeners = process.listeners(signal);
    handlers[signal] = {
      count: listeners.length,
      details: listeners.map((listener, index) => ({
        index: index + 1,
        name: listener.name || 'anonymous',
        // Extraire une partie du code source pour identifier
        source_preview: listener.toString()
          .replace(/\s+/g, ' ')
          .substring(0, 150)
          .trim() + '...'
      }))
    };
  });

  // Vérifier si on a des doublons
  const hasDuplicates = Object.values(handlers).some(info => info.count > 1);
  
  res.json({
    timestamp: new Date().toISOString(),
    has_duplicate_handlers: hasDuplicates,
    warning: hasDuplicates ? '⚠️ ATTENTION: Signaux multiples détectés!' : '✅ OK: Pas de doublons',
    handlers: handlers,
    global_flags: {
      __whatsappSignalHandlersInstalled: global.__whatsappSignalHandlersInstalled || false,
      __whatsappAlreadySetup: global.__whatsappAlreadySetup || false,
    },
    process_info: {
      pid: process.pid,
      uptime: Math.round(process.uptime()) + 's',
      listeners_SIGINT: process.listenerCount('SIGINT'),
      listeners_SIGTERM: process.listenerCount('SIGTERM'),
    }
  });
});
/* The above code is an Express route handler that handles GET requests to retrieve phone sessions for
a specific user ID. Here is a breakdown of what the code does: */
app.get("/user/:userId/phones", async (req, res) => {
  const { userId } = req.params;
  console.log(`🔍 Récupération phones pour user ${userId}`);

  try {
    const allSessionsOnDisk = scanAllSessions();
    console.log(`💾 ${allSessionsOnDisk.length} sessions trouvées sur disque`);

    const userSessionsOnDisk = allSessionsOnDisk.filter((session) =>
      session.phoneNumber.includes(`user_${userId}_`)
    );

    console.log(`🎯 ${userSessionsOnDisk.length} sessions pour user ${userId} sur disque`);

    // 🆕 GÉNÉRATION AUTOMATIQUE SI AUCUNE SESSION
    if (userSessionsOnDisk.length === 0) {
      console.log(`🆕 Aucune session, génération QR automatique pour user ${userId}`);
      
      const phoneNumber = `user_${userId}_${Date.now()}`;
      console.log(`📱 Création nouvelle session: ${phoneNumber}`);
      
      const qrResult = await generateNewQR(phoneNumber, userId);
      
      if (qrResult && qrResult.qr) {
        console.log(`✅ QR généré avec succès pour user ${userId}`);
        
        return res.json({
          success: true,
          action: "created",
          status: qrResult.status,
          qrImage: qrResult.qr,
          message: qrResult.message || "Scannez ce QR avec WhatsApp",
          ready: qrResult.ready || false,
          user_id: userId,
          phone_number: phoneNumber,
          timestamp: new Date().toISOString()
        });
      } else {
        throw new Error("Échec de la génération du QR code");
      }
    }

    // 📋 TRAITEMENT DES SESSIONS EXISTANTES
    const finalSessions = [];

    for (const session of userSessionsOnDisk) {
      try {
        console.log(`\n🔄 Traitement session: ${session.phoneNumber}`);

        let client = clientManager.clients.get(session.phoneNumber);
        const currentStatus = getSenderStatus(session.phoneNumber);
        
        console.log(`📊 Statut session: ${currentStatus.status}`);
        console.log(`✅ Authentifié: ${currentStatus.authenticated}`);
        console.log(`🚀 Ready: ${currentStatus.ready}`);

        // Si le client n'est pas en mémoire, le charger
        if (!client && !currentStatus.ready) {
          console.log(`📥 Chargement ${session.phoneNumber} en mémoire...`);
          await generateNewQRPhone(session.phoneNumber);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          client = clientManager.clients.get(session.phoneNumber);
        }

        let realPhoneNumber = null;
        let clientState = "unknown";
        let clientInfoAvailable = false;

        if (client) {
          clientState = client.state || "no_state";
          console.log(`🤖 État client: ${clientState}`);
          console.log(`📁 client.info existe: ${!!client.info}`);
          
          // Méthode 1: Vérifier directement client.info
          if (client.info && client.info.wid) {
            realPhoneNumber = client.info.wid.user;
            clientInfoAvailable = true;
            console.log(`✅ Numéro via client.info: ${realPhoneNumber}`);
          } 
          // Méthode 2: Si client.info n'est pas disponible mais la session est ready
          else if (currentStatus.ready && currentStatus.authenticated) {
            console.log(`⏳ Session ready mais client.info manquant, tentative récupération...`);
            
            // Attendre que client.info soit peuplé
            realPhoneNumber = await waitForClientInfoWithTimeout(client, session.phoneNumber, 5000);
            
            if (realPhoneNumber) {
              console.log(`✅ Numéro après attente: ${realPhoneNumber}`);
            } else {
              // Essayer d'autres méthodes
              realPhoneNumber = await tryAlternativePhoneNumberMethods(client, session.phoneNumber);
            }
          }
          
          // Debug: Afficher toutes les propriétés du client
          console.log(`🔍 Propriétés client disponibles:`, Object.keys(client).filter(k => !k.startsWith('_')).join(', '));
        }

        finalSessions.push({
          phone_number: session.phoneNumber,
          real_phone_number: realPhoneNumber,
          status: currentStatus.status,
          ready: currentStatus.ready,
          authenticated: currentStatus.authenticated,
          hasQR: currentStatus.hasQR,
          lastActivity: currentStatus.lastActivity,
          user_id: userId,
          folder_name: session.folderName,
          client_state: clientState,
          client_info_available: clientInfoAvailable
        });

        console.log(`✅ ${session.phoneNumber} - Statut: ${currentStatus.status} - Vrai: ${realPhoneNumber || "Non détecté"}`);

      } catch (sessionError) {
        console.error(`❌ Erreur sur ${session.phoneNumber}:`, sessionError.message);
        finalSessions.push({
          phone_number: session.phoneNumber,
          real_phone_number: null,
          status: "error",
          ready: false,
          authenticated: false,
          hasQR: false,
          lastActivity: null,
          user_id: userId,
          folder_name: session.folderName,
          error: sessionError.message,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log(`\n✅ ${finalSessions.length} sessions traitées pour user ${userId}`);

    console.log(`\n📊 Résumé des sessions:`) ;
    console.log(finalSessions)

    // Résumé
    const readySessions = finalSessions.filter((s) => s.ready && s.authenticated);
    const qrSessions = finalSessions.filter((s) => s.hasQR && !s.ready);
    const errorSessions = finalSessions.filter((s) => s.status === "error");
    const sessionsWithRealNumber = finalSessions.filter((s) => s.real_phone_number);

    res.json({
      success: true,
      action: "listed",
      user_id: userId,
      summary: {
        total_sessions: finalSessions.length,
        ready_sessions: readySessions.length,
        qr_sessions: qrSessions.length,
        error_sessions: errorSessions.length,
        sessions_with_real_number: sessionsWithRealNumber.length,
      },
      sessions: finalSessions,
      ready_sessions: readySessions,
      qr_sessions: qrSessions,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`❌ Erreur récupération sessions pour user ${userId}:`, err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      user_id: userId,
    });
  }
});

// Fonctions utilitaires à ajouter
async function waitForClientInfoWithTimeout(client, phoneNumber, timeout = 5000) {
  return new Promise((resolve) => {
    console.log(`⏳ Attente client.info pour ${phoneNumber} (${timeout}ms)`);
    
    // Si déjà disponible
    if (client.info && client.info.wid) {
      return resolve(client.info.wid.user);
    }
    
    const timeoutId = setTimeout(() => {
      console.log(`⏱️ Timeout attente client.info pour ${phoneNumber}`);
      client.removeListener('ready', onReady);
      resolve(null);
    }, timeout);
    
    const onReady = () => {
      console.log(`✅ ${phoneNumber} ready event reçu`);
      clearTimeout(timeoutId);
      
      // Donner un peu de temps pour que client.info soit peuplé
      setTimeout(() => {
        if (client.info && client.info.wid) {
          console.log(`📱 Numéro disponible après ready: ${client.info.wid.user}`);
          resolve(client.info.wid.user);
        } else {
          console.log(`⚠️ client.info toujours undefined après ready`);
          resolve(null);
        }
      }, 1000);
    };
    
    client.once('ready', onReady);
    
    // Vérifier aussi périodiquement
    const checkInterval = setInterval(() => {
      if (client.info && client.info.wid) {
        clearInterval(checkInterval);
        clearTimeout(timeoutId);
        client.removeListener('ready', onReady);
        console.log(`🔍 Numéro trouvé par polling: ${client.info.wid.user}`);
        resolve(client.info.wid.user);
      }
    }, 500);
    
    // Nettoyer l'intervalle au timeout
    timeoutId.interval = checkInterval;
  });
}

async function tryAlternativePhoneNumberMethods(client, phoneNumber) {
  console.log(`🔄 Tentative méthodes alternatives pour ${phoneNumber}`);
  
  try {
    // Méthode 1: Utiliser getMe() si disponible
    if (typeof client.getMe === 'function') {
      console.log(`🔍 Essai client.getMe()`);
      try {
        const me = await client.getMe();
        if (me && me.id && me.id.user) {
          console.log(`✅ Numéro via getMe: ${me.id.user}`);
          return me.id.user;
        }
      } catch (e) {
        console.log(`⚠️ getMe failed: ${e.message}`);
      }
    }
    
    // Méthode 2: Vérifier le localStorage via puppeteer
    if (client.pupPage) {
      console.log(`🌐 Lecture localStorage via page`);
      try {
        const userData = await client.pupPage.evaluate(() => {
          // Essayer plusieurs méthodes
          const store = window.Store;
          if (store && store.Conn && store.Conn.me) {
            return { source: 'Store', number: store.Conn.me.id.user };
          }
          if (window.WAPI && window.WAPI.getMyNumber) {
            return { source: 'WAPI', number: window.WAPI.getMyNumber() };
          }
          
          // Lire localStorage
          const items = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.includes('user') || key.includes('wid') || key.includes('number')) {
              try {
                items[key] = JSON.parse(localStorage.getItem(key));
              } catch {
                items[key] = localStorage.getItem(key);
              }
            }
          }
          return { source: 'localStorage', items };
        });
        
        console.log(`📊 Données page:`, JSON.stringify(userData, null, 2));
        
        if (userData.number) {
          console.log(`✅ Numéro via page: ${userData.number}`);
          return userData.number;
        }
        
        // Chercher dans les items du localStorage
        if (userData.items) {
          for (const [key, value] of Object.entries(userData.items)) {
            if (value && typeof value === 'object' && value.user) {
              console.log(`🔍 Trouvé ${key}.user: ${value.user}`);
              return value.user;
            }
            if (typeof value === 'string' && value.includes('@s.whatsapp.net')) {
              const number = value.split('@')[0];
              console.log(`🔍 Numéro dans string: ${number}`);
              return number;
            }
          }
        }
      } catch (e) {
        console.log(`⚠️ Page evaluation failed: ${e.message}`);
      }
    }
    
    console.log(`❌ Aucune méthode alternative n'a fonctionné`);
    return null;
    
  } catch (error) {
    console.log(`❌ Erreur méthodes alternatives: ${error.message}`);
    return null;
  }
}
// 7️⃣ ENVOYER MESSAGE (version corrigée)
// 7️⃣ ENVOYER MESSAGE (version ultra-simplifiée)
app.post("/send", async (req, res) => {
  const { to, text, attachments, from } = req.body;

  console.log(`📤 Envoi depuis ${from} vers ${to}`);

  if (!to || !from) {
    return res.status(400).json({
      error: "Numéro expéditeur et destinataire requis",
    });
  }

  try {
    // AJOUT: Vérifier et charger la session si nécessaire
    console.log(`🔍 Vérification session ${from}...`);
  
    
    const senderStatus = getSenderStatus(from);
    console.log(`📊 Statut session ${from}:`, senderStatus);
    
    // Si la session n'est pas prête, essayer de la charger
    if (senderStatus.status === "not_initialized" || !senderStatus.ready) {
      console.log(`🔄 Chargement session ${from}...`);
      const loadResult = await loadSessionBySession(from);
      
      // Si la session nécessite un QR code (nouvelle session ou reconnect)
      if (loadResult.qrCode && !loadResult.ready) {
        return res.status(400).json({
          error: `Session ${from} non connectée`,
          suggestion: "Scannez le QR code pour authentifier cette session WhatsApp",
          qrCode: loadResult.qrCode,
          sessionName: from,
          status: loadResult.status,
          qrExpiresIn: "5 minutes",
          from: from,
          to: to,
        });
      }
      
      // Si le chargement a échoué
      if (!loadResult.success) {
        throw new Error(`Échec chargement session ${from}: ${loadResult.error || 'Erreur inconnue'}`);
      }
      
      console.log(`✅ Session ${from} chargée avec succès`);
    }
    
    // Re-vérifier après chargement
    const finalStatus = getSenderStatus(from);
    if (!finalStatus.ready || !finalStatus.authenticated) {
      throw new Error(`Session ${from} non connectée après chargement: ${finalStatus.status}`);
    }

    console.log(`✅ ${from} est connecté, envoi du message...`);
    
    // Essayer directement d'envoyer le message
    // La fonction sendMessage gère elle-même la vérification de la connexion
    const result = await sendMessage({ to, text, attachments, from });

    res.json({
      success: true,
      message: "Message envoyé avec succès!",
      from: result.from,
      to: result.to,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`❌ Erreur envoi:`, err.message);

    // Gérer les différents types d'erreurs
    if (
      err.message.includes("non connecté") ||
      err.message.includes("non prêt") ||
      err.message.includes("non connectée")
    ) {
      return res.status(500).json({
        error: `WhatsApp non connecté sur ${from}: ${err.message}`,
        suggestion: "Générez d'abord un QR code pour cette session",
        from: from,
        to: to,
      });
    } else if (err.message.includes("non enregistré")) {
      return res.status(400).json({
        error: `Le numéro ${to} n'est pas enregistré sur WhatsApp`,
        from: from,
        to: to,
      });
    } else {
      return res.status(500).json({
        error: err.message,
        from: from,
        to: to,
      });
    }
  }
});


// ============ ADD THIS DEBUG ENDPOINT ============
app.post('/test-send', async (req, res) => {
  try {
    const { to, from } = req.body;
    const clientKey = from || 'user_3_1765664758492';
    
    console.log(`[TEST] Test send to: ${to} from: ${clientKey}`);
    
    // Make sure clientManager is available (NOT whatsappManager)
    if (!clientManager) {
      return res.json({
        success: false,
        error: "clientManager not initialized"
      });
    }
    
    // Get client directly
    const client = clientManager.clients.get(clientKey);
    if (!client) {
      return res.json({
        success: false,
        error: `Client ${clientKey} not found. Available clients: ${Array.from(clientManager.clients.keys()).join(', ')}`
      });
    }
    
    // Test connection state
    const state = clientManager.clientStates.get(clientKey);
    console.log(`[TEST] Client state:`, state);
    
    // Format number
    const cleanNumber = to.toString().replace(/\D/g, '');
    const chatId = `${cleanNumber}@c.us`;
    
    console.log(`[TEST] Formatted chatId: ${chatId}`);
    
    // Simple test message
    const result = await client.sendMessage(chatId, 'Test message from debug endpoint');
    
    res.json({
      success: true,
      messageId: result.id._serialized,
      chatId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[TEST] Error:', error);
    res.json({
      success: false,
      error: error.message,
      errorType: error.constructor.name,
      timestamp: new Date().toISOString()
    });
  }
});
// ============ END DEBUG ENDPOINT ============
// 4️⃣ STATUT DES SESSIONS D'UN USER
app.get("/user/:userId/sessions", async (req, res) => {
  const { userId } = req.params;

  try {
    const phones = await getUserPhones(userId);
    const sessions = [];

    phones.forEach((phone) => {
      const status = getSenderStatus(phone);
      sessions.push({
        phone_number: phone,
        status: status.status,
        ready: status.ready,
        authenticated: status.authenticated,
        hasQR: status.hasQR,
        lastActivity: status.lastActivity,
      });
    });

    const readySessions = sessions.filter((s) => s.ready);
    const qrSessions = sessions.filter((s) => s.hasQR && !s.ready);

    res.json({
      user_id: userId,
      total_sessions: sessions.length,
      ready_sessions: readySessions.length,
      qr_sessions: qrSessions.length,
      sessions: sessions,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      user_id: userId,
    });
  }
});

// 5️⃣ DÉCONNECTER UNE SESSION D'UN USER
app.delete("/user/:userId/session/:phoneNumber", async (req, res) => {
  const { userId, phoneNumber } = req.params;

  try {
    // Vérifier que le numéro appartient à l'utilisateur
    const userPhones = await getUserPhones(userId);
    if (!userPhones.includes(phoneNumber)) {
      return res.status(404).json({
        error: "Session non trouvée pour cet utilisateur",
      });
    }

    await disconnectClient(phoneNumber);

    // Retirer le numéro du cache local
    const updatedPhones = userPhones.filter((phone) => phone !== phoneNumber);
    userPhoneMap.set(userId, updatedPhones);

    res.json({
      success: true,
      message: `Session ${phoneNumber} déconnectée avec succès`,
      user_id: userId,
      phone_number: phoneNumber,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(
      `❌ Erreur déconnexion session ${phoneNumber} pour user ${userId}:`,
      err.message
    );
    res.status(500).json({
      error: err.message,
      user_id: userId,
      phone_number: phoneNumber,
    });
  }
});

// -----------------------------
// ROUTES EXISTANTES (compatibilité)
// -----------------------------

app.get("/generate-qr/:user_id", async (req, res) => {
  const { user_id } = req.params;

  try {
    const result = await queueUserRequest(user_id, async () => {
      console.log(`🎯 Demande QR pour user ${user_id}`);

      // Générer un numéro unique basé sur user_id + timestamp
      const phoneNumber = `user_${user_id}_${Date.now()}`;

      console.log(`📱 Génération QR avec numéro virtuel: ${phoneNumber}`);

      // Générer le QR Code avec le numéro virtuel ET associer automatiquement le user_id
      const qrResult = await generateNewQR(phoneNumber, user_id);

      if (qrResult.status === "authenticated") {
        return {
          status: "authenticated",
          message: `WhatsApp déjà connecté sur cette session`,
          ready: true,
          user_id: user_id,
          phone_number: phoneNumber,
        };
      }

      // 🆕 GÉNÉRER L'IMAGE QR ICI CAR generateNewQR NE RETOURNE PAS qrImage
      const qrImage = await QRCode.toDataURL(qrResult.qr);

      return {
        status: "qr_ready",
        qrImage: qrImage,
        qrRaw: qrResult.qr,
        message: `Scannez ce QR pour connecter une nouvelle session WhatsApp`,
        ready: false,
        user_id: user_id,
        phone_number: phoneNumber,
      };
    });
 
    // 🆕 CORRECTION: Vérifier si result existe et a qrImage
    if (req.query.format === "html" && result && result.qrImage) {
      res.send(
        `<img src="${result.qrImage}" alt="Scan WhatsApp QR for user ${user_id}" style="max-width: 300px;" />`
      );
    } else {
      res.json(result);
    }
  } catch (err) {
    console.error(`❌ Erreur QR pour user ${user_id}:`, err.message);
    res.status(500).json({
      error: err.message,
      status: "error",
      user_id: user_id,
      suggestion: "Réessayez dans 10 secondes",
    });
  }
});

app.get("/generate-qr1/:user_id", async (req, res) => {
  const { user_id } = req.params;

  try {
    const result = await queueUserRequest(user_id, async () => {
      console.log(`🎯 Demande QR JSON pour user ${user_id}`);

      // Générer un numéro unique basé sur user_id + timestamp
      const phoneNumber = `user_${user_id}_${Date.now()}`;

      console.log(`📱 Génération QR JSON avec numéro virtuel: ${phoneNumber}`);

      // Générer le QR Code avec le numéro virtuel ET associer automatiquement le user_id
      const qrResult = await generateNewQR(phoneNumber, user_id);

      if (qrResult.status === "authenticated") {
        return {
          status: "authenticated",
          message: `WhatsApp déjà connecté sur cette session`,
          ready: true,
          user_id: user_id,
          phone_number: phoneNumber,
        };
      }

      // 🆕 GÉNÉRER L'IMAGE QR ICI
      const qrImage = await QRCode.toDataURL(qrResult.qr);

      return {
        status: "qr_ready",
        qrImage: qrImage,
        qrRaw: qrResult.qr,
        message: `Scannez ce QR pour connecter une nouvelle session WhatsApp`,
        ready: false,
        user_id: user_id,
        phone_number: phoneNumber,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(`❌ Erreur QR JSON pour user ${user_id}:`, err.message);
    res.status(500).json({
      error: err.message,
      status: "error",
      user_id: user_id,
    });
  }
});



// 8️⃣ LISTER TOUS LES SENDERS CONNECTÉS
app.get("/senders", async (req, res) => {
  try {
    const senders = getConnectedSenders();

    // Enrichir avec les user_id
    const sendersWithUsers = senders.map((phone) => {
      let userId = null;
      // Trouver l'user_id depuis le cache
      for (const [uid, phones] of userPhoneMap.entries()) {
        if (phones.includes(phone)) {
          userId = uid;
          break;
        }
      }

      return {
        phone_number: phone,
        user_id: userId,
        status: getSenderStatus(phone),
      };
    });

    res.json({
      success: true,
      senders: sendersWithUsers,
      count: senders.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      success: false,
      timestamp: new Date().toISOString(),
    });
  }
});

// Routes existantes conservées pour compatibilité
app.get("/generate-qr1/:phoneNumber", async (req, res) => {
  const { phoneNumber } = req.params;

  try {
    const result = await queueUserRequest(phoneNumber, async () => {
      console.log(`🎯 Demande QR JSON pour ${phoneNumber}`);

      const qrResult = await generateNewQR(phoneNumber);

      if (qrResult.status === "authenticated") {
        return {
          status: "authenticated",
          message: `WhatsApp déjà connecté sur ${phoneNumber}`,
          ready: true,
          phoneNumber: phoneNumber,
        };
      }

      return {
        qrImage: await QRCode.toDataURL(qrResult.qr),
        qrRaw: qrResult.qr,
        status: "qr_ready",
        message: `Scannez ce QR pour ${phoneNumber}`,
        ready: false,
        phoneNumber: phoneNumber,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(`❌ Erreur QR JSON ${phoneNumber}:`, err.message);
    res.status(500).json({
      error: err.message,
      status: "error",
      phoneNumber: phoneNumber,
    });
  }
});

app.get("/sender-status/:phoneNumber", async (req, res) => {
  const { phoneNumber } = req.params;

  try {
    const status = getSenderStatus(phoneNumber);
    res.json({
      ...status,
      phoneNumber: phoneNumber,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      status: "error",
      phoneNumber: phoneNumber,
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/disconnect/:phoneNumber", async (req, res) => {
  const { phoneNumber } = req.params;

  try {
    await disconnectClient(phoneNumber);
    res.json({
      success: true,
      message: `Numéro ${phoneNumber} déconnecté avec succès`,
      note: "Appelez /generate-qr pour une nouvelle connexion",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`❌ Erreur déconnexion ${phoneNumber}:`, err.message);
    res.status(500).json({
      error: err.message,
      success: false,
      phoneNumber: phoneNumber,
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/send-bulk", async (req, res) => {
  const { messages, from } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Tableau messages requis" });
  }

  if (!from) {
    return res.status(400).json({ error: "Numéro expéditeur requis" });
  }

  if (messages.length > 1000) {
    return res.status(400).json({ error: "Maximum 1000 messages par requête" });
  }

  try {
    const startTime = Date.now();
    const results = [];

    for (let i = 0; i < messages.length; i += 5) {
      const batch = messages.slice(i, i + 5);
      const batchPromises = batch.map((message) =>
        sendMessage({
          to: message.phone,
          text: message.text,
          attachments: message.attachments,
          from: from,
        })
          .then((result) => ({ ...result, success: true }))
          .catch((error) => ({
            to: message.phone,
            success: false,
            error: error.message,
          }))
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      if (i + 5 < messages.length) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    const totalTime = Date.now() - startTime;
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    res.json({
      success: true,
      results,
      from: from,
      summary: {
        total: results.length,
        successful,
        failed,
        successRate: `${((successful / results.length) * 100).toFixed(1)}%`,
        totalTime: `${totalTime}ms`,
        averageTime: `${(totalTime / results.length).toFixed(2)}ms/message`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`❌ Erreur envoi masse depuis ${from}:`, err);
    res.status(500).json({ error: err.message, from: from });
  }
});

app.get("/system/stats", async (req, res) => {
  try {
    const stats = getStats();
    const systemStats = {
      ...stats,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      activeQueues: userQueues.size,
      userPhoneMapSize: userPhoneMap.size,
      timestamp: new Date().toISOString(),
    };

    res.json(systemStats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    activeUsers: userQueues.size,
    connectedSenders: getConnectedSenders().length,
  });
});

app.get("/queue/stats/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const queue = userQueues.get(userId);
    const phones = await getUserPhones(userId);

    const phonesStatus = {};
    phones.forEach((phone) => {
      phonesStatus[phone] = getSenderStatus(phone);
    });

    res.json({
      user_id: userId,
      queueSize: queue ? queue.length : 0,
      phones_count: phones.length,
      phones_status: phonesStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🆕 ROUTE RACINE AVEC DOCUMENTATION
app.get("/", (req, res) => {
  res.json({
    message: "🚀 API WhatsApp Multi-Sessions",
    version: "2.0.0",
    architecture: "UserID-based avec sessions multiples",
    endpoints: {
      user_qr: "GET /user/:userId/generate-qr",
      user_phones: "GET /user/:userId/phones",
      user_send: "POST /user/send",
      user_sessions: "GET /user/:userId/sessions",
      user_disconnect: "DELETE /user/:userId/session/:phoneNumber",
      direct_send: "POST /send",
      senders: "GET /senders",
      health: "GET /health",
      stats: "GET /system/stats",
    },
    timestamp: new Date().toISOString(),
  });
});

// Démarrer serveur
const server = app.listen(PORT, () => {
  console.log(`🚀 API WhatsApp écoutant port ${PORT}`);
  console.log(`📊 Environnement: ${process.env.NODE_ENV || "development"}`);
  console.log(`🎯 Architecture: UserID-based avec sessions multiples`);
  console.log(`📱 Chaque user peut avoir plusieurs sessions WhatsApp`);
  console.log(`⚡ Prêt pour l'envoi multi-senders!`);
});

// Arrêt gracieux
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM reçu, arrêt...");
  server.close(() => {
    console.log("✅ Serveur fermé");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  console.log("🛑 SIGINT reçu, arrêt...");
  server.close(() => {
    console.log("✅ Serveur fermé");
    process.exit(0);
  });
});
