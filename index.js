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
const fs = require("fs");
const path = require("path");

// ============================================================
// CHAVES DE API
// ============================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!GEMINI_API_KEY) console.warn("⚠️ GEMINI_API_KEY não encontrada.");
if (!GROQ_API_KEY)   console.warn("⚠️ GROQ_API_KEY não encontrada.");
if (!CLAUDE_API_KEY) console.warn("⚠️ ANTHROPIC_API_KEY não encontrada.");

const anthropic = CLAUDE_API_KEY ? new Anthropic({ apiKey: CLAUDE_API_KEY }) : null;

// ============================================================
// ESTADO GLOBAL
// ============================================================
let sockInstance = null; // referência ao socket para envio de notificações
let currentQRUrl = null;
let botOnline = false;

// Histórico de conversas por cliente
const conversationHistory = new Map();

// State machine por cliente para captura de lead
// { stage: 'normal' | 'awaiting_name' | 'awaiting_email', leadData: {} }
const customerState = new Map();

// Estatísticas de latência
const modeloStats = {
  gemini: { total: 0, count: 0 },
  groq:   { total: 0, count: 0 },
  claude: { total: 0, count: 0 },
};

function registrarLatencia(modelo, ms) {
  modeloStats[modelo].total += ms;
  modeloStats[modelo].count++;
}

// ============================================================
// PERSISTÊNCIA DE HISTÓRICO
// ============================================================
const HISTORY_FILE = path.join(__dirname, "data", "history.json");

function carregarHistorico() {
  try {
    if (!fs.existsSync(path.dirname(HISTORY_FILE))) {
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    }
    if (fs.existsSync(HISTORY_FILE)) {
      const dados = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      for (const [jid, msgs] of Object.entries(dados)) {
        conversationHistory.set(jid, msgs);
      }
      console.log(`📂 Histórico carregado: ${conversationHistory.size} conversas.`);
    }
  } catch (e) {
    console.warn("⚠️ Não foi possível carregar histórico:", e.message);
  }
}

function salvarHistorico() {
  try {
    const dados = {};
    for (const [jid, msgs] of conversationHistory.entries()) {
      dados[jid] = msgs;
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(dados), "utf8");
  } catch (e) {
    console.warn("⚠️ Não foi possível salvar histórico:", e.message);
  }
}

// Salva histórico a cada 60 segundos
setInterval(salvarHistorico, 60_000);

// ============================================================
// HORÁRIO DE ATENDIMENTO (Cuiabá UTC-4)
// ============================================================
function dentroDoHorario() {
  const agora = new Date();
  const cuiaba = new Date(agora.toLocaleString("en-US", { timeZone: "America/Cuiaba" }));
  const hora = cuiaba.getHours();
  const dia = cuiaba.getDay(); // 0 = domingo, 6 = sábado
  if (dia === 0 || dia === 6) return false;
  return hora >= 8 && hora < 18;
}

// ============================================================
// NOTIFICAÇÕES INTERNAS (WhatsApp do advogado)
// ============================================================
async function notificarAdvogado(mensagem) {
  const numero = process.env.ADVOGADO_NUMERO;
  if (!sockInstance || !numero) return;
  const jid = numero.includes("@") ? numero : `${numero}@s.whatsapp.net`;
  try {
    await sockInstance.sendMessage(jid, { text: mensagem });
  } catch (e) {
    console.error("❌ Erro ao notificar advogado:", e.message);
  }
}

// ============================================================
// GOOGLE SHEETS (via Google Apps Script — sem custo)
// ============================================================
async function logPlanilha(dados) {
  const url = process.env.GOOGLE_SCRIPT_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...dados, data: new Date().toISOString() })
    });
  } catch (e) {
    console.error("❌ Erro ao registrar na planilha:", e.message);
  }
}

// ============================================================
// CONFIGURAÇÃO DO BOT
// ============================================================
const BOT_CONFIG = {
  businessName: "JD Advogados",
  maxHistoryLength: 20,
  agendamentoLink: "https://outlook.office.com/book/JulianDavisAdvocacia1@juliandavis.adv.br/?ismsaljsauthenabled",

  welcomeMessage:
    "Olá! 👋 Bem-vindo ao *JD Advogados*.\n\n" +
    "Sou o assistente virtual do escritório, especializado em *Direito Tributário*, *Direito Empresarial* e *Direito Patrimonial*.\n\n" +
    "Como posso te ajudar hoje?",

  systemPrompt: `Você é o assistente virtual do escritório JD Advogados (Dr. Julian Davis Santa Rosa), especializado em Direito Tributário, Direito Empresarial e Direito Patrimonial. Localizado em Cuiabá, Mato Grosso.

SOBRE O ESCRITÓRIO:
- Advogado: Dr. Julian Davis Santa Rosa (OAB-MT)
- Especialidades: Direito Tributário, Empresarial e Patrimonial
- Localização: Cuiabá / MT | Site: jdadvogados.adv.br
- Atendimento presencial e remoto em todo o Brasil

COMO VOCÊ DEVE SE COMPORTAR:
- Seja cordial, profissional e consultivo — como um escritório de alto padrão
- Responda sempre em português do Brasil com linguagem acessível
- Nunca forneça pareceres jurídicos nem opiniões sobre casos específicos
- Nunca informe valores de honorários
- Identifique o perfil do cliente pela mensagem e apresente o serviço mais relevante
- Seja objetivo: explique brevemente o serviço e convide para um agendamento ou para deixar o contato
- Nunca revele o número pessoal do advogado

SERVIÇOS DO ESCRITÓRIO:

▶ PARA EMPRESÁRIOS E EMPRESAS:
- Constituição de Holdings Patrimoniais Familiares (proteção de patrimônio e sucessão)
- Assessoria Tributária Empresarial contínua (regime tributário, obrigações, reforma)
- Planejamento Tributário com identificação de oportunidades de economia fiscal
- Análise de Cenários para empresas do Simples Nacional diante da Reforma Tributária
- Reprecificação Tributária pós-Reforma (adequação de preços na transição IBS/CBS)
- Recuperação de ITBI para operações imobiliárias PJ (Tema 1.113 STF)
- Parecer de Situação Fiscal Federal (e-CAC, multas, intimações, risco de inaptidão do CNPJ)
- Elaboração, alteração e revisão de contratos sociais

▶ PARA FAMÍLIAS EMPRESÁRIAS:
- Planejamento Sucessório Avançado (redução de ITCMD, prevenção de conflitos familiares)
- Holding Patrimonial Familiar (estruturação societária para proteção e sucessão)
- Aftercare de Holdings já constituídas (manutenção e atualização)
- Revisão de ITCMD em inventários e doações com valores superestimados

▶ PARA PESSOAS FÍSICAS:
- Recuperação de IRPF para portadores de doenças graves (isenção Lei 7.713/88)
- Recuperação de IRPF para pessoas com TEA ou Síndrome de Down
- Recuperação de IRPF sobre precatórios (RRA — art. 12-A Lei 7.713/88)
- Defesa em fiscalização da Receita Federal (malha fina, autos de infração, intimações)
- Revisão de ITCMD em heranças e doações pagas a maior
- Recuperação de ITBI pago a maior em compra de imóvel (Tema 1.113 STF)
- Mandado de Segurança preventivo para evitar ITBI superestimado antes do pagamento
- Análise do impacto da Reforma Tributária sobre receitas de locação (IBS/CBS)

▶ PARA CONTRATOS E IMÓVEIS:
- Elaboração e revisão de contratos de compra e venda de imóvel
- Due diligence imobiliária (análise de documentação e certidões)
- Defesa em ações de cobrança, execução e inventário
- Elaboração e revisão de contratos de locação e contratos cíveis em geral

▶ PARA ADVOGADOS DE OUTROS ESTADOS (PARCERIA):
- O JD Advogados possui Plataforma de Auditoria Tributária própria para identificar créditos recuperáveis
- Modelo de parceria: o JD fornece a tecnologia e o expertise técnico; o advogado parceiro representa o cliente localmente
- Aplicável principalmente a recuperação de IRPF (doença grave, TEA/Down, precatórios), ITCMD e ITBI
- Se o interlocutor for advogado, apresente essa oportunidade e convide para uma conversa

CAMPANHA ATIVA — CALCULADORA TRIBUTÁRIA (SIMPLES NACIONAL):
- O escritório realiza campanha voltada a empresas optantes do Simples Nacional
- A Reforma Tributária exige uma OPÇÃO até setembro de 2025 com efeitos a partir de 2027
- É fundamental simular diferentes cenários tributários antes de decidir
- O JD Advogados desenvolveu uma Calculadora Tributária para apoiar essa decisão
- Versão básica disponível gratuitamente; versão completa mediante contratação
- Quando esse tema surgir (reforma, Simples Nacional, opção tributária, IBS, CBS), explique brevemente e ofereça agendamento pelo link: https://outlook.office.com/book/JulianDavisAdvocacia1@juliandavis.adv.br/?ismsaljsauthenabled

COMO IDENTIFICAR O PERFIL DO CLIENTE:
- Menciona empresa, CNPJ, sócios, faturamento → perfil empresarial
- Menciona doença grave, imposto de renda retido, TEA, Síndrome de Down → recuperação PF
- Menciona inventário, herança, imóvel, ITBI, ITCMD, doação → patrimonial/imóvel
- É advogado, menciona clientes dele, outro estado → parceria de plataforma
- Menciona reforma tributária, Simples Nacional, opção 2025/2027 → campanha calculadora

CAPTURA DE LEAD:
- Quando o cliente demonstrar interesse genuíno em contratar ou saber mais sobre um serviço específico, ao final da sua resposta inclua exatamente a palavra: COLETAR_LEAD

TRANSFERÊNCIA PARA HUMANO:
- Se o cliente pedir para falar com o advogado, insistir em detalhes de um caso específico, ou você não souber responder adequadamente, diga que vai encaminhar para o Dr. Julian e termine com a palavra: TRANSFERIR_HUMANO`,
};

// ============================================================
// SERVIDOR WEB (QR Code e status)
// ============================================================
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

  if (botOnline) {
    res.end(`
      <html><body style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5;font-family:sans-serif">
        <div style="background:white;padding:2rem;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);text-align:center">
          <h2 style="color:#128C7E">🤖 Bot Online!</h2>
          <p>O assistente virtual do JD Advogados está ativo.</p>
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

// ============================================================
// IA — ordem fixa: Gemini → Groq → Claude
// ============================================================
async function getAIResponse(customerId, customerMessage) {
  if (!conversationHistory.has(customerId)) {
    conversationHistory.set(customerId, []);
  }

  const history = conversationHistory.get(customerId);
  history.push({ role: "user", content: customerMessage });

  if (history.length > BOT_CONFIG.maxHistoryLength) {
    history.splice(0, history.length - BOT_CONFIG.maxHistoryLength);
  }

  async function tentarGemini() {
    if (!GEMINI_API_KEY) return null;
    try {
      const inicio = Date.now();
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
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
        console.error("❌ Erro no Gemini:", JSON.stringify(data));
        return null;
      }
      return data.candidates[0].content.parts[0].text;
    } catch (e) {
      console.error("❌ Falha no Gemini:", e.message);
      return null;
    }
  }

  async function tentarGroq() {
    if (!GROQ_API_KEY) return null;
    try {
      const inicio = Date.now();
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: BOT_CONFIG.systemPrompt },
            ...history.map(h => ({ role: h.role, content: h.content }))
          ],
          max_tokens: 1024
        })
      });
      const data = await response.json();
      registrarLatencia("groq", Date.now() - inicio);
      if (!data?.choices?.[0]?.message?.content) {
        console.error("❌ Erro no Groq:", JSON.stringify(data));
        return null;
      }
      return data.choices[0].message.content;
    } catch (e) {
      console.error("❌ Falha no Groq:", e.message);
      return null;
    }
  }

  async function tentarClaude() {
    if (!anthropic) return null;
    try {
      const inicio = Date.now();
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: BOT_CONFIG.systemPrompt,
        messages: history.map(h => ({ role: h.role, content: h.content }))
      });
      registrarLatencia("claude", Date.now() - inicio);
      return response.content[0].text;
    } catch (e) {
      console.error("❌ Falha no Claude:", e.message);
      return null;
    }
  }

  for (const [nome, fn] of [["Gemini", tentarGemini], ["Groq", tentarGroq], ["Claude", tentarClaude]]) {
    console.log(`🤖 Tentando ${nome}...`);
    const resposta = await fn();
    if (resposta) {
      console.log(`✅ Respondido pelo ${nome}`);
      history.push({ role: "assistant", content: resposta });
      return resposta;
    }
    console.warn(`⚠️ ${nome} falhou, tentando próximo...`);
  }

  return "Desculpe, estou com instabilidade no momento. Tente novamente em instantes.";
}

// ============================================================
// EXTRAIR TEXTO DA MENSAGEM
// ============================================================
function extrairTexto(message) {
  const m = message.message;
  if (!m) return "";

  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;

  const tipos = [
    "imageMessage", "videoMessage", "documentMessage",
    "audioMessage", "buttonsResponseMessage", "listResponseMessage",
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

// ============================================================
// REMETENTE (compatível com WhatsApp Business)
// ============================================================
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

// ============================================================
// PROCESSAR MENSAGEM RECEBIDA
// ============================================================
async function processarMensagem(sock, remoteJid, texto) {
  const numero = remoteJid.replace("@s.whatsapp.net", "").replace("@lid", "");
  const estado = customerState.get(remoteJid) || { stage: "normal", leadData: {} };

  // --- Captura de nome ---
  if (estado.stage === "awaiting_name") {
    estado.leadData.nome = texto.trim();
    estado.stage = "awaiting_email";
    customerState.set(remoteJid, estado);
    await sock.sendMessage(remoteJid, { text: `Obrigado, ${estado.leadData.nome}! 😊 E qual é o seu melhor e-mail para contato?` });
    return;
  }

  // --- Captura de e-mail ---
  if (estado.stage === "awaiting_email") {
    estado.leadData.email = texto.trim();
    estado.stage = "normal";
    customerState.set(remoteJid, estado);

    const notif =
      `🟢 *Novo Lead Capturado!*\n` +
      `👤 Nome: ${estado.leadData.nome}\n` +
      `📧 E-mail: ${estado.leadData.email}\n` +
      `📱 WhatsApp: +${numero}`;

    await notificarAdvogado(notif);
    await logPlanilha({ tipo: "lead", nome: estado.leadData.nome, email: estado.leadData.email, whatsapp: numero });

    await sock.sendMessage(remoteJid, {
      text:
        `Perfeito! Seus dados foram registrados. ✅\n\n` +
        `Em breve o Dr. Julian entrará em contato com você. Caso prefira já agendar uma conversa, acesse:\n` +
        `${BOT_CONFIG.agendamentoLink}`
    });
    return;
  }

  // --- Verificar horário de atendimento ---
  if (!dentroDoHorario()) {
    await sock.sendMessage(remoteJid, {
      text:
        `Olá! Obrigado por entrar em contato com o *JD Advogados*. 🕐\n\n` +
        `No momento estamos fora do horário de atendimento (segunda a sexta, 8h às 18h).\n\n` +
        `Seu contato ficou registrado e retornaremos no próximo dia útil. Se preferir já garantir um horário, agende pelo link:\n` +
        `${BOT_CONFIG.agendamentoLink}`
    });
    await notificarAdvogado(
      `⏰ *Contato fora do horário*\n📱 +${numero}\n💬 "${texto.substring(0, 100)}"`
    );
    return;
  }

  // --- Resposta da IA ---
  const aiReply = await getAIResponse(remoteJid, texto);

  // --- Processar marcadores ---
  if (aiReply.includes("TRANSFERIR_HUMANO")) {
    const textoLimpo = aiReply.replace("TRANSFERIR_HUMANO", "").trim();
    await sock.sendMessage(remoteJid, { text: textoLimpo });

    const hist = conversationHistory.get(remoteJid) || [];
    const resumo = hist.slice(-6)
      .map(h => `${h.role === "user" ? "Cliente" : "Bot"}: ${h.content.substring(0, 120)}`)
      .join("\n");

    await notificarAdvogado(
      `🔴 *Cliente quer falar com o advogado!*\n📱 +${numero}\n\n*Últimas mensagens:*\n${resumo}`
    );
    await logPlanilha({ tipo: "transferencia", whatsapp: numero, resumo: resumo.substring(0, 300) });
    return;
  }

  if (aiReply.includes("COLETAR_LEAD")) {
    const textoLimpo = aiReply.replace("COLETAR_LEAD", "").trim();
    customerState.set(remoteJid, { stage: "awaiting_name", leadData: {} });
    await sock.sendMessage(remoteJid, {
      text: textoLimpo + "\n\nPara que possamos entrar em contato, pode me dizer seu nome?"
    });
    return;
  }

  // Resposta normal
  await sock.sendMessage(remoteJid, { text: aiReply });
}

// ============================================================
// INICIAR BOT
// ============================================================
async function iniciarBot() {
  console.log(`\n🤖 Iniciando Bot WhatsApp — ${BOT_CONFIG.businessName}...`);

  carregarHistorico();

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

  sockInstance = sock; // expõe para notificações internas

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
      sockInstance = null;

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

      console.log(`📩 Mensagem de ${remoteJid}: "${texto.substring(0, 80)}"`);

      try {
        await processarMensagem(sock, remoteJid, texto);
      } catch (e) {
        console.error("❌ Erro ao processar mensagem:", e.message);
      }
    }
  });
}

iniciarBot();
