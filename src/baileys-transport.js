import { chmod, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";

import { ALLOWED_RECIPIENTS } from "./message.js";

const allowedRecipients = new Set(ALLOWED_RECIPIENTS);
const guardedSignalConsoles = new WeakSet();

function suppressSignalSessionDumps(consoleObject) {
  if (!consoleObject || guardedSignalConsoles.has(consoleObject)) return;
  const originalInfo = consoleObject.info?.bind(consoleObject);
  if (!originalInfo) return;
  consoleObject.info = (...entries) => {
    if (entries[0] === "Closing session:") return;
    originalInfo(...entries);
  };
  guardedSignalConsoles.add(consoleObject);
}

async function writePrivateQr(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await QRCode.toFile(filePath, value, {
    type: "png",
    width: 720,
    margin: 3,
    errorCorrectionLevel: "M",
  });
  await chmod(filePath, 0o600);
}

async function removeIfPresent(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function createBaileysTransport({
  authDir,
  qrPath,
  logger = console,
  socketFactory = async (options) => makeWASocket(options),
  authStateFactory = async () => useMultiFileAuthState(authDir),
  versionFactory = fetchLatestBaileysVersion,
  qrWriter = writePrivateQr,
  removeFile = removeIfPresent,
  scheduleReconnect = (callback) => setTimeout(callback, 3000),
  cancelReconnect = (timer) => clearTimeout(timer),
  signalConsole = console,
}) {
  suppressSignalSessionDumps(signalConsole);
  let connectionState = "disconnected";
  let socket = null;
  let reconnectTimer = null;
  let stopped = false;
  let connectPromise = null;

  async function connect() {
    if (stopped) return;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
      const { state, saveCreds } = await authStateFactory();
      const { version } = await versionFactory();
      socket = await socketFactory({
        auth: state,
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      });

      socket.ev.on("creds.update", saveCreds);
      socket.ev.on("connection.update", handleConnectionUpdate);
    })();

    try {
      await connectPromise;
    } finally {
      connectPromise = null;
    }
  }

  async function handleConnectionUpdate(update) {
    if (update.qr) {
      connectionState = "linking";
      await qrWriter(qrPath, update.qr);
      logger.info({ whatsapp: "linking", qr: "written" });
    }

    if (update.connection === "open") {
      connectionState = "connected";
      if (reconnectTimer) cancelReconnect(reconnectTimer);
      reconnectTimer = null;
      await removeFile(qrPath);
      logger.info({ whatsapp: "connected" });
      return;
    }

    if (update.connection !== "close") return;
    const statusCode = update.lastDisconnect?.error?.output?.statusCode;
    if (statusCode === DisconnectReason.loggedOut) {
      connectionState = "logged_out";
      logger.error({ whatsapp: "logged_out" });
      return;
    }

    connectionState = "disconnected";
    logger.error({ whatsapp: "disconnected" });
    if (!stopped && !reconnectTimer) {
      reconnectTimer = scheduleReconnect(async () => {
        reconnectTimer = null;
        try {
          await connect();
        } catch {
          connectionState = "disconnected";
          logger.error({ whatsapp: "reconnect_failed" });
        }
      });
    }
  }

  return {
    start: connect,

    status() {
      return connectionState;
    },

    async send({ to, text, attachments = [] }) {
      if (!allowedRecipients.has(to)) throw new Error("Recipient is not allowlisted");
      if (connectionState !== "connected" || !socket) {
        throw new Error("WhatsApp transport is disconnected");
      }

      const jid = `${to}@s.whatsapp.net`;
      const textResult = await socket.sendMessage(jid, { text });
      const messageIds = [textResult?.key?.id].filter(Boolean);

      for (const attachment of attachments) {
        let content;
        if (attachment.kind === "image") {
          content = {
            image: { url: attachment.path },
            caption: "How the voice-to-WhatsApp prototype works",
          };
        } else if (attachment.kind === "document") {
          content = {
            document: { url: attachment.path },
            fileName: attachment.fileName,
            mimetype: attachment.mimetype,
          };
        } else {
          throw new Error("Unsupported WhatsApp attachment kind");
        }
        const attachmentResult = await socket.sendMessage(jid, content);
        if (attachmentResult?.key?.id) messageIds.push(attachmentResult.key.id);
      }

      return { messageIds };
    },

    async stop() {
      stopped = true;
      if (reconnectTimer) cancelReconnect(reconnectTimer);
      reconnectTimer = null;
      connectionState = "stopped";
      socket?.end?.(new Error("Bridge stopping"));
      socket = null;
      await removeFile(qrPath);
    },
  };
}
