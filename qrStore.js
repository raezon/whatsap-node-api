// whatsapp/qrStore.js
let currentQR = null;
let timestamp = null;

function setQR(qr) {
  currentQR = qr;
  timestamp = new Date();
}

function getQR() {
  return { qr: currentQR, timestamp };
}

module.exports = { setQR, getQR };
