require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");

const Anthropic = require("@anthropic-ai/sdk"); // Claude fallback opcional
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const http = require("http");
const pino = require("pino");

// Gemini (principal) usa fetch nativo do Node 20

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO DE CHAVES
// ─────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY não encontrada!");
  process.exit(1);
}

const anthropic = CLAUDE_API_KEY ? new Anthropic({ apiKey: CLAUDE_API_KEY }) : null;

// ─────────────────────────────────────────────────────────────
// HISTÓRICO DE CONVERSA + MÉTRICAS DE LATÊNCIA
// ─────────────────────────────────────────────────────────────
const conversationHistory = new Map();

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

// ─────────────────────────────────────────────────────────────
// CLASSIFICADOR DE COMPLEXIDADE (modo econômico)
// ─────────────────────────────────────────────────────────────
function classificarMensagem(texto) {
  const simples = [
    "oi", "olá", "bom dia", "boa tarde", "boa noite",
    "tudo bem", "como funciona", "horário", "atendimento"
  ];

  if (texto.length < 20) return "simples";
  if (simples.some(p => texto.toLowerCase().includes(p))) return "simples";

  return "complexa";
}

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO DO BOT
// ─────────────────────────────────────────────────────────────
let currentQRUrl = null;
let botOnline = false;

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
- Use linguagem acessível, evite termos jurídicos complexos sem explicação
- Nunca dê pareceres jurídicos ou opiniões legais — apenas oriente o cliente a agendar uma consulta
- Mantenha respostas curtas, adequadas para WhatsApp (sem markdown excessivo)

O QUE VOCÊ PODE FAZER:
- Informar as áreas de atuação do escritório
- Explicar brevemente o que é Direito Empresarial e Tributário
- Agendar consultas (colete: nome completo, assunto e melhor horário)
- Responder dúvidas gerais sobre como funciona o atendimento
- Informar que consultas iniciais são realizadas presencialmente ou por videoconferência

O QUE VOCÊ NÃO DEVE FAZER:
- Dar opiniões sobre casos específicos
- Prometer resultados
- Falar sobre honorários (diga que isso é tratado diretamente com o advogado)

TRANSFERÊNCIA PARA HUMANO:
- Se o cliente insistir em detalhes de um caso específico, quiser falar com o advogado, ou você não souber responder, diga que vai transferir para um atendente e termine sua resposta com a palavra TRANSFERIR_HUMANO`,
};

// ─────────────────────────────────────────────────────────────
// SERVIDOR WEB (QR CODE)
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// FUNÇÕES AUXILIARES
// ─────────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extrairTexto(message) {
  const m = message.message;
  if (!m) return "";

  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;

  const tipos = [
    "imageMessage", "videoMessage", "documentMessage",
    "audioMessage", "buttonsResponseMessage", "listResponseMessage",
    "templateMessage",
  ];

  for (const tipo of tipos) {
    if (m[tipo]?.caption) return m[tipo].caption;
    if (m[tipo]?.text) return m[tipo].text;
  }

  try {
    const contentType = getContentType(m);
    if (contentType && m[contentType]) {
      return (
        m[contentType]?.text ||
        m[contentType]?.caption ||
        m[contentType]?.conversation ||
        ""
      );
    }
  } catch {}

  return "";
}

function obterRemetente(message) {
  if (message.key.remoteJid?.includes("@lid")) {
    return message.key.senderPn || message.key.remoteJid;
  }
  return message.key.remoteJid;
}

//FUNÇÃO DE IA + FALLBACK + BALANCEAMENTO

/* ─────────────────────────────────────────────────────────────
   FUNÇÃO PRINCIPAL DE IA
   Gemini = modelo principal
   Claude = fallback opcional
   Balanceamento automático + modo econômico
────────────────────────────────────────────────────────────── */

async function getAIResponse(customerId, customerMessage) {
  if (!conversationHistory.has(customerId)) {
    conversationHistory.set(customerId, []);
  }

  const history = conversationHistory.get(customerId);

  // Adiciona mensagem do usuário ao histórico
  history.push({
    role: "user",
    content: customerMessage,
    parts: [{ text: customerMessage }]
  });

  // Limita histórico
  if (history.length > BOT_CONFIG.maxHistoryLength) {
    history.splice(0, history.length - BOT_CONFIG.maxHistoryLength);
  }

  // Salva resposta no histórico
  const saveReply = (reply) => {
    history.push({
      role: "assistant",
      content: reply,
      parts: [{ text: reply }]
    });
  };

  // Classificação da mensagem (modo econômico)
  const tipo = classificarMensagem(customerMessage);

  // Modelo prioritário
  let prioridade = tipo === "simples" ? "gemini" : "claude";

  // Balanceamento automático
  const maisRapido = modeloMaisRapido();
  if (maisRapido !== prioridade) {
    prioridade = maisRapido;
  }

  console.log(`⚖️ Modelo escolhido: ${prioridade.toUpperCase()} (tipo: ${tipo})`);

  // ───────────────────────────────────────────────
  // Funções de chamada dos modelos
  // ───────────────────────────────────────────────

  async function tentarGemini() {
    const inicio = Date.now();

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: {
            role: "system",
            parts: [{ text: BOT_CONFIG.systemPrompt }]
          },
          contents: history.map(h => ({
            role: h.role === "assistant" ? "model" : "user",
            parts: [{ text: h.content }]
          }))
        })
      }
    );

    const data = await response.json();

    registrarLatencia("gemini", Date.now() - inicio);

    return (
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Desculpe, não consegui gerar uma resposta agora."
    );
  }

  async function tentarClaude() {
    if (!anthropic) throw new Error("Claude não configurado");

    const inicio = Date.now();

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: BOT_CONFIG.systemPrompt,
      messages: history.map(h => ({
        role: h.role,
        content: h.content
      }))
    });

    registrarLatencia("claude", Date.now() - inicio);

    return response.content[0].text;
  }

  // Ordem de tentativa
  const ordem =
    prioridade === "gemini"
      ? [tentarGemini, tentarClaude]
      : [tentarClaude, tentarGemini];

  // Execução com fallback
  for (const tentativa of ordem) {
    try {
      const resposta = await tentativa();
      saveReply(resposta);
      return resposta;
    } catch (err) {
      console.error("⚠️ Erro ao tentar modelo:", err.message);
    }
  }

  return "Desculpe, estou com instabilidade no momento. Tente novamente em instantes.";
}
//WhatsApp + Eventos + Finalização

/* ─────────────────────────────────────────────────────────────
   INICIAR BOT WHATSAPP
────────────────────────────────────────────────────────────── */

async function startBot() {
  console.log(`\n🤖 Iniciando Bot WhatsApp + Gemini/Claude...`);
  console.log(`📋 Empresa: ${BOT_CONFIG.businessName}\n`);

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    syncFullHistory: true,
    markOnlineOnConnect: true,
    getMessage: async () => ({ conversation: "" }),
  });

  // QR CODE
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

    if (connection === "close") {
      botOnline = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log("⚠️ Conexão encerrada. Reconectando:", shouldReconnect);

      if (shouldReconnect) {
        await delay(3000);
        startBot();
      } else {
        console.log("❌ Sessão encerrada. Delete a pasta auth_info e reinicie.");
      }
    }

    if (connection === "open") {
      botOnline = true;
      currentQRUrl = null;
      console.log(`\n✅ Bot "${BOT_CONFIG.businessName}" está online!\n`);
      console.log("Aguardando mensagens...\n");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // RECEBIMENTO DE MENSAGENS
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const message of messages) {
      if (message.key.fromMe) continue;

      const remoteJid = message.key.remoteJid || "";

      // Ignorar grupos, status, newsletters
      if (remoteJid.includes("@g.us")) continue;
      if (remoteJid === "status@broadcast") continue;
      if (remoteJid.includes("@newsletter")) continue;

      // Ignorar mensagens internas
      if (message.message?.protocolMessage) continue;
      if (message.message?.reactionMessage) continue;

      const customerId = obterRemetente(message);
      const customerMessage = extrairTexto(message);

      if (!customerMessage.trim()) continue;

      console.log(`\n📩 Mensagem de ${customerId}: "${customerMessage}"`);

      try {
        const isNewCustomer = !conversationHistory.has(customerId);

        if (isNewCustomer) {
          await sock.sendMessage(customerId, { text: BOT_CONFIG.welcomeMessage });
          await delay(800);
        }

        const aiReply = await getAIResponse(customerId, customerMessage);

        console.log(`🤖 Resposta IA: ${aiReply.substring(0, 80)}...`);

        // Transferência para humano
        if (aiReply.includes("TRANSFERIR_HUMANO")) {
          const cleanReply = aiReply.replace("TRANSFERIR_HUMANO", "").trim();

          await sock.sendMessage(customerId, { text: cleanReply });
          await handleHumanTransfer(sock, customerId, customerMessage);

          conversationHistory.delete(customerId);
          continue;
        }

        await sock.sendMessage(customerId, { text: aiReply });

      } catch (error) {
        console.error("❌ Erro:", error.message);
        await sock.sendMessage(customerId, {
          text: "Desculpe, tive um problema técnico. Tente novamente em instantes.",
        });
      }
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   TRANSFERÊNCIA PARA HUMANO
────────────────────────────────────────────────────────────── */

async function handleHumanTransfer(sock, customerId, lastMessage) {
  console.log(`\n🔄 Transferindo ${customerId} para humano`);

  if (BOT_CONFIG.advogadoNumero) {
    await sock.sendMessage(BOT_CONFIG.advogadoNumero, {
      text:
        `🔔 *Novo atendimento solicitado*\n\n` +
        `📱 Cliente: ${customerId.replace("@s.whatsapp.net", "")}\n` +
        `💬 Última mensagem: "${lastMessage}"\n\n` +
        `Acesse o WhatsApp para continuar o atendimento.`,
    });
  }
}

/* ─────────────────────────────────────────────────────────────
   LIMPEZA DE HISTÓRICO
────────────────────────────────────────────────────────────── */

setInterval(() => {
  let cleaned = 0;
  conversationHistory.forEach((_, id) => {
    conversationHistory.delete(id);
    cleaned++;
  });

  if (cleaned > 0) console.log(`🧹 ${cleaned} conversas limpas`);
}, 2 * 60 * 60 * 1000);

/* ─────────────────────────────────────────────────────────────
   INICIAR BOT
────────────────────────────────────────────────────────────── */

startBot().catch((err) => {
  console.error("❌ Erro fatal:", err);
  process.exit(1);
});
