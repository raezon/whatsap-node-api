const { getClient, Buttons, MessageMedia } = require('./client');
const path = require('path');
const fs = require('fs');

async function sendMessage({ phone, name, text, messageType, attachments }) {
    const client = await getClient();

    // ✅ Check if number is on WhatsApp
    const numberDetails = await client.getNumberId(phone);
    if (!numberDetails) return { success: false, message: 'Number not registered on WhatsApp' };

    const chatId = numberDetails._serialized;

    // ✅ Separate attachments by type
    const images = [];
    const documents = [];

    if (attachments && Array.isArray(attachments)) {
        for (const att of attachments) {
            if (!att?.type || !att?.data) continue;

            const mime = att.type.toLowerCase();

            if (mime.startsWith('image/')) {
                images.push(att);
            } else if (mime.includes('pdf') || mime.includes('doc') || mime.includes('docx')) {
                documents.push(att);
            }
        }
    }

    // ✅ CASE 1: No attachments → just text
    if (images.length === 0 && documents.length === 0) {
        if (messageType === 'button') {
            const buttons = new Buttons(text, [{ body: 'Yes' }, { body: 'No' }]);
            await client.sendMessage(chatId, buttons);
        } else if (text) {
            await client.sendMessage(chatId, text);
        }
        return { success: true };
    }

    // ✅ CASE 2: Only images
    if (images.length > 0 && documents.length === 0) {
        for (let i = 0; i < images.length; i++) {
            const att = images[i];
            const ext = att.type.split('/')[1] || 'bin';
            const filename = `tmp_img_${Date.now()}_${i}.${ext}`;
            const filepath = path.join(__dirname, filename);

            const base64Data = att.data.replace(/^data:.+;base64,/, '');
            fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));

            const media = MessageMedia.fromFilePath(filepath);
            await client.sendMessage(chatId, media, { caption: i === 0 ? text : '' });

            fs.unlinkSync(filepath);
        }
        return { success: true };
    }

    // ✅ CASE 3: Only PDFs/docs
    if (images.length === 0 && documents.length > 0) {
        // send text first
        if (text) {
            await client.sendMessage(chatId, text);
        }

        // then send documents
        for (let i = 0; i < documents.length; i++) {
            const att = documents[i];
            const ext = att.type.split('/')[1] || 'bin';
            const filename = `tmp_doc_${Date.now()}_${i}.${ext}`;
            const filepath = path.join(__dirname, filename);

            const base64Data = att.data.replace(/^data:.+;base64,/, '');
            fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));

            const media = MessageMedia.fromFilePath(filepath);
            await client.sendMessage(chatId, media);

            fs.unlinkSync(filepath);
        }
        return { success: true };
    }

    // ✅ CASE 4: Both images + PDFs/docs
    if (images.length > 0 && documents.length > 0) {
        // send all images first (first one with caption)
        for (let i = 0; i < images.length; i++) {
            const att = images[i];
            const ext = att.type.split('/')[1] || 'bin';
            const filename = `tmp_img_${Date.now()}_${i}.${ext}`;
            const filepath = path.join(__dirname, filename);

            const base64Data = att.data.replace(/^data:.+;base64,/, '');
            fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));

            const media = MessageMedia.fromFilePath(filepath);
            await client.sendMessage(chatId, media, { caption: i === 0 ? text : '' });

            fs.unlinkSync(filepath);
        }

        // send text again after all images (for clarity)
        if (text) {
            await client.sendMessage(chatId, text);
        }

        // then send PDFs/docs
        for (let i = 0; i < documents.length; i++) {
            const att = documents[i];
            const ext = att.type.split('/')[1] || 'bin';
            const filename = `tmp_doc_${Date.now()}_${i}.${ext}`;
            const filepath = path.join(__dirname, filename);

            const base64Data = att.data.replace(/^data:.+;base64,/, '');
            fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));

            const media = MessageMedia.fromFilePath(filepath);
            await client.sendMessage(chatId, media);

            fs.unlinkSync(filepath);
        }

        return { success: true };
    }

    return { success: true };
}

module.exports = { sendMessage };
