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
const http = require("http");
const pino = require("pino");

// IA
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY não encontrada! O bot funcionará apenas com Claude.");
}


const anthropic = CLAUDE_API_KEY ? new Anthropic({ apiKey: CLAUDE_API_KEY }) : null;

// Histórico
const conversationHistory = new Map();
let currentQRUrl = null;
let botOnline = false;

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
  advogadoNumero: process.env.ADVOGADO_NUMERO || "",
  welcomeMessage:
    "Olá! 👋 Bem-vindo ao *JD Advocacia*.\n\n" +
    "Sou o assistente virtual do escritório, especializado em *Direito Empresarial* e *Direito Tributário*.\n\n" +
    "Como posso te ajudar hoje?",
  systemPrompt: `Você é o assistente virtual do escritório JD Advocacia, especializado em Direito Empresarial e Direito Tributário.

SOBRE O ESCRITÓRIO:
- Especialidades: Direito Empresarial e Direito Tributário
- Atendimento: de segunda a sexta, das 8h às 18h

COMO VOCÊ DEVE SE COMPORTAR:
- Seja cordial, profissional e objetivo
- Responda sempre em português do Brasil
- Use linguagem acessível
- Nunca dê pareceres jurídicos
- Mantenha respostas curtas

TRANSFERÊNCIA PARA HUMANO:
- Se o cliente insistir em detalhes de um caso específico, quiser falar com o advogado, ou você não souber responder, diga que vai transferir para um atendente e termine sua resposta com a palavra TRANSFERIR_HUMANO`,
};

// Servidor Web
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

  if (botOnline) {
    res.end(`
      <html><body style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5;font-family:sans-serif">
        <div style="background:white;padding:2rem;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);text-align:center">
          <h2 style="color:#128C7E">🤖 Bot Online!</h2>
          <p>O assistente virtual do JD Advocacia está ativo.</p>
        </div>
      </body></html>
    `);
    return;
  }

  if (currentQRUrl) {
    res.end(`
      <html><body style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5;font-family:sans-serif">
        <div style="background:white;padding:2rem;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);text-align:center">
          <h2 style="color:#128C7E">📱 Escaneie o QR Code</h2>
          <img src="${currentQRUrl}" width="260" />
        </div>
      </body></html>
    `);
    return;
  }

  res.end(`
    <html><body style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5;font-family:sans-serif">
      <div style="background:white;padding:2rem;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);text-align:center">
        <h2 style="color:#128C7E">⏳ Iniciando...</h2>
        <p>Aguarde o QR Code aparecer.</p>
      </div>
    </body></html>
  `);
});

server.listen(process.env.PORT || 8080, () => {
  console.log(`🌐 Servidor web ativo na porta ${process.env.PORT || 8080}`);
});

// IA
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

  console.log(`⚖️ Modelo escolhido: ${prioridade.toUpperCase()} (tipo: ${tipo})`);

  // GEMINI ATUALIZADO
  async function tentarGemini() {
  if (!GEMINI_API_KEY) return null;

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

      if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.error("❌ Erro no Gemini:", data);
        return null;
      }

      return data.candidates[0].content.parts[0].text;
    } catch (e) {
      console.error("❌ Falha no Gemini:", e);
      return null;
    }
  }

  async function tentarClaude() {
    if (!anthropic) return null;

    try {
      const inicio = Date.now();

      const response = await anthropic.messages.create({
        model: "claude-3-5-sonnet-latest",
        max_tokens: 1024,
        system: BOT_CONFIG.systemPrompt,
        messages: history.map(h => ({ role: h.role, content: h.content }))
      });

      registrarLatencia("claude", Date.now() - inicio);
      return response.content[0].text;
    } catch (e) {
      console.error("❌ Falha no Claude:", e);
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

  return "Desculpe, estou com instabilidade no momento. Tente novamente em instantes.";
}

// Extrair texto
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

// Remetente compatível com Business
function obterRemetente(message) {
  const jid = message.key.remoteJid;

  if (jid.includes("@lid")) {
    return (
      message.key.participant ||
      message.key.sender ||
      message.key.senderPn ||
      jid
    );
  }

  return jid;
}

// Iniciar Bot
async function iniciarBot() {
  console.log(`\n🤖 Iniciando Bot WhatsApp + Gemini/Claude...`);
  console.log(`📋 Empresa: ${BOT_CONFIG.businessName}\n`);

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

      QRCode.toDataURL(qr, (err, url) => {
        if (!err) {
          currentQRUrl = url;
          console.log("✅ QR Code disponível.\n");
        }
      });
    }

    if (connection === "open") {
      botOnline = true;
      currentQRUrl = null;
      console.log(`\n✅ Bot "${BOT_CONFIG.businessName}" está online!\n`);
    }

    if (connection === "close") {
      botOnline = false;

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

      const remoteJid = obterRemetente(msg);
      const texto = extrairTexto(msg);

      if (!texto.trim()) continue;

      console.log(`📩 Mensagem recebida de ${remoteJid}: "${texto}"`);

      const aiReply = await getAIResponse(remoteJid, texto);

      await sock.sendMessage(remoteJid, { text: aiReply });
    }
  });
}

iniciarBot();
