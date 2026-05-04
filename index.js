require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  getContentType
} = require("@whiskeysockets/baileys");

const Anthropic = require("@anthropic-ai/sdk");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const pino = require("pino");
const nodemailer = require("nodemailer");

// IA
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADVOGADO_NUMERO = process.env.ADVOGADO_NUMERO;

if (!ADVOGADO_NUMERO) {
  console.error("❌ ERRO: Variável ADVOGADO_NUMERO não definida.");
}

const anthropic = CLAUDE_API_KEY ? new Anthropic({ apiKey: CLAUDE_API_KEY }) : null;

// Histórico
const conversationHistory = new Map();

// Estatísticas
const modeloStats = {
  gemini: { total: 0, count: 0 },
  claude: { total: 0, count: 0 },
};

function registrarLatencia(modelo, ms) {
  modeloStats[modelo].total += ms;
  modeloStats[modelo].count++;
}

function modeloMaisRapido() {
  const g = modeloStats.gemini;
  const c = modeloStats.claude;
  const gemAvg = g.count ? g.total / g.count : Infinity;
  const claAvg = c.count ? c.total / c.count : Infinity;
  return gemAvg <= claAvg ? "gemini" : "claude";
}

function classificarMensagem(texto) {
  const simples = ["oi","olá","bom dia","boa tarde","boa noite","tudo bem","como funciona","horário","atendimento"];
  if (texto.length < 20) return "simples";
  if (simples.some(p => texto.toLowerCase().includes(p))) return "simples";
  return "complexa";
}

const BOT_CONFIG = {
  businessName: "JD Advocacia",
  maxHistoryLength: 20,
  systemPrompt: `Você é o assistente virtual do escritório JD Advocacia, especializado em Direito Empresarial e Direito Tributário.

COMPORTAMENTO:
- Seja cordial, profissional e objetivo
- Responda sempre em português do Brasil
- Nunca dê parecer jurídico
- Respostas curtas e claras

TRANSFERÊNCIA:
- Se o cliente pedir para falar com o advogado, insistir em detalhes ou você não souber responder, finalize com TRANSFERIR_HUMANO`
};

// =========================
// IA
// =========================

async function getAIResponse(customerId, customerMessage) {
  if (!conversationHistory.has(customerId)) {
    conversationHistory.set(customerId, []);
  }

  const history = conversationHistory.get(customerId);

  history.push({ role: "user", content: customerMessage });

  if (history.length > BOT_CONFIG.maxHistoryLength) {
    history.splice(0, history.length - BOT_CONFIG.maxHistoryLength);
  }

  const saveReply = (reply) => {
    history.push({ role: "assistant", content: reply });
  };

  const tipo = classificarMensagem(customerMessage);
  let prioridade = tipo === "simples" ? "gemini" : "claude";
  const maisRapido = modeloMaisRapido();
  if (maisRapido !== prioridade) prioridade = maisRapido;

  async function tentarGemini() {
    if (!GEMINI_API_KEY) return null;

    try {
      const inicio = Date.now();

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { role: "system", parts: [{ text: BOT_CONFIG.systemPrompt }] },
            contents: history.map(h => ({
              role: h.role === "assistant" ? "model" : "user",
              parts: [{ text: h.content }]
            }))
          })
        }
      );

      const data = await response.json();
      registrarLatencia("gemini", Date.now() - inicio);

      return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch {
      return null;
    }
  }

  async function tentarClaude() {
    if (!anthropic) return null;

    try {
      const inicio = Date.now();

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: BOT_CONFIG.systemPrompt,
        messages: history.map(h => ({ role: h.role, content: h.content }))
      });

      registrarLatencia("claude", Date.now() - inicio);
      return response.content[0].text;
    } catch {
      return null;
    }
  }

  const ordem = prioridade === "gemini"
    ? [tentarGemini, tentarClaude]
    : [tentarClaude, tentarGemini];

  for (const tentativa of ordem) {
    const resposta = await tentativa();
    if (resposta) {
      saveReply(resposta);
      return resposta;
    }
  }

  return "Desculpe, estou com instabilidade no momento. Tente novamente.";
}

// =========================
// Extrair texto
// =========================

function extrairTexto(message) {
  const m = message.message;
  if (!m) return "";

  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;

  const tipos = [
    "imageMessage","videoMessage","documentMessage",
    "audioMessage","buttonsResponseMessage","listResponseMessage",
    "templateMessage"
  ];

  for (const tipo of tipos) {
    if (m[tipo]?.caption) return m[tipo].caption;
    if (m[tipo]?.text) return m[tipo].text;
  }

  try {
    const contentType = getContentType(m);
    if (contentType && m[contentType]) {
      return m[contentType]?.text ||
             m[contentType]?.caption ||
             m[contentType]?.conversation ||
             "";
    }
  } catch {}

  return "";
}

// =========================
// Envio para advogado (WhatsApp + E-mail)
// =========================

async function enviarParaAdvogado(sock, numeroCliente, mensagemCliente, respostaIA) {
  if (!ADVOGADO_NUMERO) return;

  const texto = [
    "⚠️ *Atendimento humano solicitado!*",
    "",
    `*Número do cliente:* ${numeroCliente}`,
    "",
    `*Mensagem do cliente:*`,
    mensagemCliente,
    "",
    `*Resposta da IA:*`,
    respostaIA,
    "",
    "*Motivo:* IA solicitou transferência (TRANSFERIR_HUMANO)",
  ].join("\n");

  await sock.sendMessage(ADVOGADO_NUMERO, { text: texto });
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function enviarEmail(numeroCliente, mensagemCliente, respostaIA) {
  if (!process.env.SMTP_HOST) return;

  const html = `
    <h2>⚠️ Atendimento humano solicitado</h2>
    <p><strong>Número do cliente:</strong> ${numeroCliente}</p>
    <p><strong>Mensagem do cliente:</strong><br>${mensagemCliente}</p>
    <p><strong>Resposta da IA:</strong><br>${respostaIA}</p>
    <p><strong>Motivo:</strong> IA solicitou transferência (TRANSFERIR_HUMANO)</p>
  `;

  await transporter.sendMail({
    from: `"JD Advocacia - Bot" <${process.env.SMTP_USER}>`,
    to: process.env.EMAIL_DESTINO || "julian@jdadvogados.adv.br",
    subject: "Atendimento humano solicitado",
    html,
  });
}

// =========================
// Iniciar Bot (Baileys 7.x)
// =========================

async function iniciarBot() {
  console.log(`\n🤖 Iniciando Bot WhatsApp + IA...`);

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    syncFullHistory: true,
    markOnlineOnConnect: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    getMessage: async () => ({ conversation: "" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 QR Code gerado!\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log(`\n✅ Bot conectado!\n`);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log("⚠️ Conexão encerrada. Reconectando:", shouldReconnect);

      if (shouldReconnect) {
        await new Promise(r => setTimeout(r, 3000));
        iniciarBot();
      } else {
        console.log("❌ Sessão encerrada. Delete a pasta auth_info e reinicie.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const texto = extrairTexto(msg);

      if (!texto.trim()) continue;

      console.log(`📩 Mensagem recebida de ${remoteJid}: "${texto}"`);

      const aiReply = await getAIResponse(remoteJid, texto);

      await sock.sendMessage(remoteJid, { text: aiReply });

      if (aiReply.includes("TRANSFERIR_HUMANO")) {
        await enviarParaAdvogado(sock, remoteJid, texto, aiReply);
        await enviarEmail(remoteJid, texto, aiReply);
      }
    }
  });
}

iniciarBot();
