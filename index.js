const express = require("express");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const fs = require("fs");
const axios = require("axios");
const path = require("path");
const {
  generateNewQR,
  sendMessage,
  getSenderStatus,
  getConnectedSenders,
  disconnectClient,
  getAllSessions,
  scanAllSessions,
  getStats,
  Buttons,
  loadSession,
  MessageMedia,
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
    "http://localhost:8080",
    "http://localhost:3000",
    "http://localhost:4000",
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

      // Générer un "phone number" basé sur le user ID + timestamp
      const phoneNumber = `user_${userId}_${Date.now()}`;

      console.log(`📱 Génération QR avec numéro virtuel: ${phoneNumber}`);

      // Générer le QR Code avec ce numéro virtuel
      const qrResult = await generateNewQR(phoneNumber);

      if (qrResult.status === "authenticated") {
        return {
          status: "authenticated",
          message: `WhatsApp déjà connecté sur cette session`,
          ready: true,
          user_id: userId,
          phone_number: phoneNumber,
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

/* The above code is an Express route handler that handles GET requests to retrieve phone sessions for
a specific user ID. Here is a breakdown of what the code does: */
app.get("/user/:userId/phones", async (req, res) => {
  const { userId } = req.params;
  console.log(`📞 Recherche sessions pour user ${userId}`);

  try {
    const allSessionsOnDisk = scanAllSessions();
    console.log(`💾 ${allSessionsOnDisk.length} sessions trouvées sur disque`);

    const userSessionsOnDisk = allSessionsOnDisk.filter((session) =>
      session.phoneNumber.includes(`user_${userId}_`)
    );

    console.log(
      `🎯 ${userSessionsOnDisk.length} sessions pour user ${userId} sur disque`
    );

    const finalSessions = [];

    for (const session of userSessionsOnDisk) {
      try {
        console.log(`🔄 Traitement session: ${session.phoneNumber}`);

        if (!session.existsInMemory) {
          console.log(`📥 Chargement ${session.phoneNumber} en mémoire...`);
          await generateNewQR(session.phoneNumber);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        const currentStatus = getSenderStatus(session.phoneNumber);

        // 🆕 CORRECTION: Utiliser client.info instead of client.getMe()
        let realPhoneNumber = null;
        try {
          const { clientManager } = require("./client");
          const client = clientManager.clients.get(session.phoneNumber);
          if (client && currentStatus.ready && client.info) {
            realPhoneNumber = client.info.wid.user;
            console.log(`📱 Vrai numéro détecté: ${realPhoneNumber}`);
          }
        } catch (error) {
          console.log(
            `⚠️ Impossible de récupérer le vrai numéro: ${error.message}`
          );
        }

        finalSessions.push({
          phone_number: session.phoneNumber,
          real_phone_number: realPhoneNumber, // 🆕
          status: currentStatus.status,
          ready: currentStatus.ready,
          authenticated: currentStatus.authenticated,
          hasQR: currentStatus.hasQR,
          lastActivity: currentStatus.lastActivity,
          user_id: userId,
          folder_name: session.folderName,
        });

        console.log(
          `✅ ${session.phoneNumber} - Statut: ${
            currentStatus.status
          } - Vrai: ${realPhoneNumber || "Non détecté"}`
        );
      } catch (sessionError) {
        console.error(
          `❌ Erreur sur ${session.phoneNumber}:`,
          sessionError.message
        );
        finalSessions.push({
          phone_number: realPhoneNumber , // 🆕 Utilise le vrai numéro si disponible
          real_phone_number: realPhoneNumber,
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

    console.log(
      `✅ ${finalSessions.length} sessions traitées pour user ${userId}`
    );

    const readySessions = finalSessions.filter(
      (s) => s.ready && s.authenticated
    );
    const qrSessions = finalSessions.filter((s) => s.hasQR && !s.ready);
    const errorSessions = finalSessions.filter((s) => s.status === "error");
    const sessionsWithRealNumber = finalSessions.filter(
      (s) => s.real_phone_number
    );

    res.json({
      success: true,
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
    console.error(
      `❌ Erreur récupération sessions pour user ${userId}:`,
      err.message
    );
    res.status(500).json({
      error: err.message,
      user_id: userId,
    });
  }
});
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
      err.message.includes("non prêt")
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

// 6️⃣ GÉNÉRER QR CODE POUR UN NUMÉRO SPÉCIFIQUE (si besoin)
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
    console.log("Generated QR result:", result);
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

// 7️⃣ ENVOYER MESSAGE (version simple avec numéro direct)
app.post("/send", async (req, res) => {
  const { to, text, attachments, from } = req.body;

  console.log(`📤 Tentative d'envoi depuis ${from} vers ${to}`);

  if (!to) {
    return res.status(400).json({ error: "Numéro destinataire requis" });
  }

  if (!from) {
    return res.status(400).json({ error: "Numéro expéditeur requis" });
  }

  //try {
  // 🆕 VÉRIFICATION RENFORCÉE DE LA CONNEXION
  console.log(`🔍 Vérification connexion pour ${from}`);

  // CORRECTION: Utiliser clientManager au lieu de sessions
  const { getSenderStatus, sendMessage, loadSession } = require("./client");

  // Vérifier si le client existe en mémoire
  const senderStatus = getSenderStatus(from);
  console.log(`📱 Statut de ${from}:`, senderStatus);

  // Si le client n'est pas initialisé ou pas prêt
  if (senderStatus.status === "not_initialized" || !senderStatus.ready) {
    console.log(`🔄 Tentative de chargement de la session ${from}`);
    try {
      await loadSession(from);
      console.log(`✅ Session ${from} chargée avec succès`);

      // Re-vérifier le statut après chargement
      const newStatus = getSenderStatus(from);
      console.log(`📊 Nouveau statut de ${from}:`, newStatus);

      if (!newStatus.ready) {
        return res.status(500).json({
          error: `WhatsApp non prêt après chargement: ${newStatus.status}`,
          from: from,
          to: to,
          status: newStatus.status,
        });
      }
    } catch (loadError) {
      console.error(`❌ Erreur chargement session ${from}:`, loadError.message);
      return res.status(500).json({
        error: `Session non chargée: ${loadError.message}`,
        from: from,
        to: to,
      });
    }
  }

  // Vérifier le statut final
  const finalStatus = getSenderStatus(from);
  console.log(`📊 Statut final de ${from}:`, finalStatus);

  if (!finalStatus.ready || !finalStatus.authenticated) {
    return res.status(500).json({
      error: `WhatsApp non prêt: ${finalStatus.status}`,
      from: from,
      to: to,
      status: finalStatus.status,
      ready: finalStatus.ready,
      authenticated: finalStatus.authenticated,
    });
  }

  console.log(`✅ ${from} est connecté, envoi du message...`);
  const result = await sendMessage({ to, text, attachments, from });

  res.json({
    success: true,
    message: "Message envoyé avec succès!",
    from: result.from,
    to: result.to,
    timestamp: new Date().toISOString(),
  });
  /*} catch (err) {
    console.error(`❌ Erreur envoi depuis ${from} vers ${to}:`, err.message);
    res.status(500).json({
      error: err.message,
      from: from,
      to: to,
      timestamp: new Date().toISOString(),
    });*/
  //  }
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
