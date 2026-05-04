const fs = require("fs");
const path = require("path");

// =========================
// LIMPA auth_info ANTES DE QUALQUER OUTRA COISA
// =========================
try {
  if (fs.existsSync("auth_info")) {
    console.log("⚠️ Removendo pasta auth_info para forçar QR...");
    fs.rmSync("auth_info", { recursive: true, force: true });
  }
} catch (err) {
  console.log("Não foi possível remover auth_info, continuando mesmo assim.");
}

// =========================
// Imports básicos
// =========================
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const { Boom } = require("@hapi/boom");

// IMPORTA BAILEYS APENAS UMA VEZ
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

// =========================
// Variáveis de ambiente
// =========================
require("dotenv").config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

// WhatsApp do advogado
const ADVOGADO_WA =
  process.env.ADVOGADO_WA || "5565999102630@s.whatsapp.net";

// Arquivo JSON de transferências
const TRANSFERENCIAS_FILE = path.join(__dirname, "transferencias.json");

// Usuário e senha do painel
const ADMIN_USER = process.env.ADMIN_USER || "juliandavis";
const ADMIN_PASS = process.env.ADMIN_PASS || "30866173";

// =========================
// Estado global
// =========================
let sock;
let ultimoQR = null;

// =========================
// Inicialização do Express
// =========================
const app = express();
const PORT = process.env.PORT || 8080;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(
  session({
    secret: "jdadvogados-secret-session",
    resave: false,
    saveUninitialized: false,
  })
);

// =========================
// Funções auxiliares: JSON de transferências
// =========================

function carregarTransferencias() {
  try {
    if (!fs.existsSync(TRANSFERENCIAS_FILE)) {
      fs.writeFileSync(TRANSFERENCIAS_FILE, JSON.stringify([]));
      return [];
    }
    const data = fs.readFileSync(TRANSFERENCIAS_FILE, "utf8");
    return JSON.parse(data || "[]");
  } catch (err) {
    console.error("Erro ao carregar transferencias.json:", err);
    return [];
  }
}

function salvarTransferencias(lista) {
  try {
    fs.writeFileSync(TRANSFERENCIAS_FILE, JSON.stringify(lista, null, 2));
  } catch (err) {
    console.error("Erro ao salvar transferencias.json:", err);
  }
}

function registrarTransferencia({ numero, nome, mensagem, motivo }) {
  const lista = carregarTransferencias();
  const nova = {
    id: Date.now().toString(),
    numero,
    nome: nome || "Não informado",
    mensagem,
    motivo: motivo || "Solicitação da IA",
    status: "pendente",
    criadoEm: new Date().toISOString(),
  };
  lista.push(nova);
  salvarTransferencias(lista);
  return nova;
}

function marcarTransferenciaComoAtendida(id) {
  const lista = carregarTransferencias();
  const idx = lista.findIndex((t) => t.id === id);
  if (idx >= 0) {
    lista[idx].status = "atendido";
    lista[idx].atendidoEm = new Date().toISOString();
    salvarTransferencias(lista);
    return true;
  }
  return false;
}

// =========================
// Nodemailer (e-mail)
// =========================
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 465),
  secure: true,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

async function enviarEmailTransferencia(transferencia) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn("⚠️ SMTP não configurado. E-mail não será enviado.");
    return;
  }

  const { numero, nome, mensagem, motivo, criadoEm } = transferencia;

  const mailOptions = {
    from: `"JD Advogados - Bot" <${SMTP_USER}>`,
    to: "julian@jdadvogados.adv.br",
    subject: "Cliente solicitou atendimento humano",
    html: `
      <h2>Atendimento humano solicitado</h2>
      <p><strong>Nome:</strong> ${nome}</p>
      <p><strong>Número:</strong> ${numero}</p>
      <p><strong>Mensagem:</strong> ${mensagem}</p>
      <p><strong>Motivo:</strong> ${motivo}</p>
      <p><strong>Data/Hora:</strong> ${new Date(criadoEm).toLocaleString(
        "pt-BR"
      )}</p>
      <hr/>
      <p>Este e-mail foi gerado automaticamente pelo sistema JD Advogados.</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("📧 E-mail de transferência enviado para o advogado.");
  } catch (err) {
    console.error("Erro ao enviar e-mail de transferência:", err);
  }
}

// =========================
// WhatsApp (Baileys) com QR forçado
// =========================
async function iniciarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["JDAdvogados", "Chrome", "1.0"],

    // ESSENCIAL: força versão estável do WhatsApp Web
    version: [2, 3000, 101]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("🔥 QR Code gerado!");
      ultimoQR = qr;
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log("Conexão fechada. Reconectar:", shouldReconnect);
      if (shouldReconnect) iniciarWhatsApp();
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado.");
      ultimoQR = null;
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    if (remoteJid.endsWith("@g.us")) return;

    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    console.log(`📩 Mensagem recebida de ${remoteJid}: ${texto}`);

    const resposta = await processarMensagemIA(remoteJid, texto);

    if (resposta?.textoLimpo) {
      await sock.sendMessage(remoteJid, { text: resposta.textoLimpo });
    }

    if (resposta?.transferirHumano) {
      console.log("🔄 IA solicitou transferência para humano.");

      const transferencia = registrarTransferencia({
        numero: remoteJid,
        nome: "Cliente WhatsApp",
        mensagem: texto,
        motivo: "IA retornou TRANSFERIR_HUMANO",
      });

      await enviarWhatsAppParaAdvogado(transferencia);
      await enviarEmailTransferencia(transferencia);
    }
  });
}

async function enviarWhatsAppParaAdvogado(transferencia) {
  if (!sock) {
    console.warn("⚠️ Socket WhatsApp não inicializado.");
    return;
  }

  const { numero, nome, mensagem, motivo, criadoEm } = transferencia;

  const texto = [
    "⚠️ *Atendimento humano solicitado!*",
    "",
    `*Nome:* ${nome}`,
    `*Número:* ${numero}`,
    `*Mensagem:* ${mensagem}`,
    `*Motivo:* ${motivo}`,
    `*Data/Hora:* ${new Date(criadoEm).toLocaleString("pt-BR")}`,
    "",
    "Acesse o painel: /dashboard",
  ].join("\n");

  try {
    await sock.sendMessage(ADVOGADO_WA, { text: texto });
    console.log("📲 Mensagem enviada ao advogado.");
  } catch (err) {
    console.error("Erro ao enviar WhatsApp:", err);
  }
}

// =========================
// IA: Gemini + Claude
// =========================
async function chamarGemini(prompt) {
  if (!GEMINI_API_KEY) return null;

  try {
    const resp = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
        GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    const data = await resp.json();
    const texto =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Desculpe, tive um problema ao responder.";

    return { modelo: "GEMINI", texto };
  } catch {
    return null;
  }
}

async function chamarClaude(prompt) {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await resp.json();
    const texto =
      data?.content?.[0]?.text ||
      "Desculpe, tive um problema ao responder.";

    return { modelo: "CLAUDE", texto };
  } catch {
    return null;
  }
}

function analisarTransferencia(texto) {
  if (!texto) return { textoLimpo: "", transferirHumano: false };

  const marcador = "TRANSFERIR_HUMANO";
  const transferirHumano = texto.includes(marcador);
  const textoLimpo = texto.replace(marcador, "").trim();

  return { textoLimpo, transferirHumano };
}

async function processarMensagemIA(numero, mensagem) {
  try {
    const tipo = mensagem.length <= 120 ? "simples" : "complexa";

    let respostaIA =
      tipo === "simples"
        ? await chamarGemini(mensagem)
        : await chamarClaude(mensagem);

    if (!respostaIA)
      respostaIA =
        tipo === "simples"
          ? await chamarClaude(mensagem)
          : await chamarGemini(mensagem);

    if (!respostaIA)
      return {
        textoLimpo:
          "Estou com dificuldades técnicas agora. Tente novamente em instantes.",
        transferirHumano: false,
      };

    const { textoLimpo, transferirHumano } = analisarTransferencia(
      respostaIA.texto
    );

    return { textoLimpo, transferirHumano };
  } catch {
    return {
      textoLimpo:
        "Ocorreu um erro ao processar sua mensagem. Tente novamente.",
      transferirHumano: false,
    };
  }
}

// =========================
// Middleware de autenticação
// =========================
function requireLogin(req, res, next) {
  if (req.session?.logado) return next();
  return res.redirect("/login");
}

// =========================
// Rotas de Login
// =========================
app.get("/login", (req, res) => {
  const erro = req.query.erro ? "Usuário ou senha inválidos." : "";

  res.send(`
    <html><body>
      <h2>Login</h2>
      <form method="POST" action="/login">
        <input name="usuario" placeholder="Usuário" />
        <input name="senha" type="password" placeholder="Senha" />
        <button>Entrar</button>
        <div>${erro}</div>
      </form>
    </body></html>
  `);
});

app.post("/login", (req, res) => {
  const { usuario, senha } = req.body;
  if (usuario === ADMIN_USER && senha === ADMIN_PASS) {
    req.session.logado = true;
    return res.redirect("/dashboard");
  }
  return res.redirect("/login?erro=1");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// =========================
// Rota do QR
// =========================
app.get("/qr", requireLogin, (req, res) => {
  if (!ultimoQR)
    return res.send("<h3>Aguardando geração do QR...</h3>");

  res.send(`<pre>${ultimoQR}</pre>`);
});

// =========================
// Dashboard
// =========================
app.get("/dashboard", requireLogin, (req, res) => {
  const transferencias = carregarTransferencias().sort(
    (a, b) => new Date(b.criadoEm) - new Date(a.criadoEm)
  );

  if (ultimoQR)
    return res.send(`
      <h2>Conectar WhatsApp</h2>
      <iframe src="/qr" style="width:100%;height:260px;"></iframe>
    `);

  const linhas = transferencias
    .map(
      (t) => `
      <tr>
        <td>${t.id}</td>
        <td>${t.nome}</td>
        <td>${t.numero}</td>
        <td>${new Date(t.criadoEm).toLocaleString("pt-BR")}</td>
        <td>${t.mensagem}</td>
        <td>${t.motivo}</td>
        <td>${t.status}</td>
        <td>
          ${
            t.status === "pendente"
              ? `<form method="POST" action="/transferencias/${t.id}/atender">
                   <button>Atender</button>
                 </form>`
              : "-"
          }
        </td>
      </tr>`
    )
    .join("");

  res.send(`
    <h2>Painel</h2>
    <table border="1" cellpadding="5">
      <tr>
        <th>ID</th><th>Nome</th><th>Número</th><th>Data</th>
        <th>Mensagem</th><th>Motivo</th><th>Status</th><th>Ação</th>
      </tr>
      ${linhas}
    </table>
  `);
});

// =========================
// Marcar como atendido
// =========================
app.post("/transferencias/:id/atender", requireLogin, (req, res) => {
  marcarTransferenciaComoAtendida(req.params.id);
  res.redirect("/dashboard");
});

// =========================
// Rota raiz
// =========================
app.get("/", (req, res) => {
  res.send("Bot JD Advogados rodando. Acesse /login");
});

// =========================
// Inicialização
// =========================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

iniciarWhatsApp().catch((err) =>
  console.error("Erro ao iniciar WhatsApp:", err)
);
