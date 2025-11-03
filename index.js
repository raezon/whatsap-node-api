const express = require("express");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const { getQR, getClient } = require("./client");
const { MessageMedia } = require("whatsapp-web.js");

const app = express();

// ✅ Augmenter la limite pour recevoir des fichiers en Base64
app.use(bodyParser.json({ limit: "100mb" }));
app.use(bodyParser.urlencoded({ limit: "100mb", extended: true }));

// ✅ Créer le dossier uploads si nécessaire
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// GET /generate-qr
app.get("/generate-qr", async (req, res) => {
  const { qr } = getQR();
  if (!qr) return res.status(404).json({ message: "QR not available yet" });

  const qrImage = await QRCode.toDataURL(qr);
  res.send(`<img src="${qrImage}" alt="Scan WhatsApp QR" />`);
});

// GET /status
app.get("/status", async (req, res) => {
  try {
    const client = await getClient();
    const state = await client.getState();
    res.json({ connected: state === "CONNECTED" });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// POST /send
app.post("/send", async (req, res) => {
  try {
    const { phone, text, attachments } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Phone is required" });
    }

    const client = await getClient();
    const numberDetails = await client.getNumberId(phone);

    if (!numberDetails) {
      return res
        .status(400)
        .json({ error: "Number not registered on WhatsApp" });
    }

    const chatId = numberDetails._serialized;

    // Separate attachments by type
    const images = [];
    const documents = [];

    if (attachments && Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att?.type || !att?.data) continue;

        const mime = att.type.toLowerCase();
        if (mime.startsWith("image/")) {
          images.push(att);
        } else if (mime.includes("pdf") || mime.includes("doc") || mime.includes("docx")) {
          documents.push(att);
        }
      }
    }

    // CASE 1: No attachments → send text only
    if (images.length === 0 && documents.length === 0) {
      if (text) await client.sendMessage(chatId, text);
      return res.json({ success: true, message: "Text sent" });
    }

    // CASE 2: Images exist → send images first
    if (images.length > 0) {
      for (let i = 0; i < images.length; i++) {
        const att = images[i];
        const ext = att.type.split("/")[1] || "bin";
        const filename = `upload_img_${Date.now()}_${i}.${ext}`;
        const filePath = path.join(uploadsDir, filename);

        const base64Data = att.data.replace(/^data:.+;base64,/, "");
        fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));

        const media = MessageMedia.fromFilePath(filePath);
        // caption only on first image
        await client.sendMessage(chatId, media, { caption: i === 0 ? text : "" });

        fs.unlinkSync(filePath);
      }
    }

    // CASE 3: PDFs exist → send text first if no images
    if (documents.length > 0 && images.length === 0 && text) {
      await client.sendMessage(chatId, text);
    }

    // CASE 4: Send PDFs/documents
    for (let i = 0; i < documents.length; i++) {
      const att = documents[i];
      const ext = att.type.split("/")[1] || "bin";
      const filename = `upload_doc_${Date.now()}_${i}.${ext}`;
      const filePath = path.join(uploadsDir, filename);

      const base64Data = att.data.replace(/^data:.+;base64,/, "");
      fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));

      const media = MessageMedia.fromFilePath(filePath);
      await client.sendMessage(chatId, media);

      fs.unlinkSync(filePath);
    }

    return res.json({ success: true, message: "Message sent successfully!" });
  } catch (err) {
    console.error("❌ Error sending message:", err);
    res.status(500).json({ error: err.message });
  }
});


app.listen(4000, () => console.log("🚀 WhatsApp API listening on port 4000"));
