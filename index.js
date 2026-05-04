// =========================
// Imports básicos
// =========================
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const { Boom } = require("@hapi/boom");
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
// Limpeza automática da pasta auth_info
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
// Inicialização do Express
// =========================
const app = express();
const PORT = process.env.PORT || 3000;

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
    printQRInTerminal: false, // vamos capturar o QR manualmente
    browser: ["JDAdvogados", "Chrome", "1.0"], // força modo QR
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
      if (shouldReconnect) {
        iniciarWhatsApp();
      }
    } else if (connection === "open") {
      console.log("✅ WhatsApp conectado.");
      ultimoQR = null; // limpa o QR quando conecta
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith("@g.us");
    if (isGroup) return;

    const texto =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    console.log(`📩 Mensagem recebida de ${remoteJid}: ${texto}`);

    const resposta = await processarMensagemIA(remoteJid, texto);

    if (resposta && resposta.textoLimpo) {
      await sock.sendMessage(remoteJid, { text: resposta.textoLimpo });
    }

    if (resposta && resposta.transferirHumano) {
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
    console.warn(
      "⚠️ Socket WhatsApp não inicializado. Não foi possível enviar ao advogado."
    );
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
    "Acesse o painel para mais detalhes: /dashboard",
  ].join("\n");

  try {
    await sock.sendMessage(ADVOGADO_WA, { text: texto });
    console.log(
      "📲 Mensagem de transferência enviada ao advogado no WhatsApp."
    );
  } catch (err) {
    console.error("Erro ao enviar WhatsApp para advogado:", err);
  }
}
// =========================
// IA: Gemini + Claude
// =========================
async function chamarGemini(prompt) {
  if (!GEMINI_API_KEY) {
    console.warn("⚠️ GEMINI_API_KEY não encontrada. Ignorando Gemini.");
    return null;
  }

  try {
    console.log("🤖 Chamando Gemini...");
    const resp = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
        GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
        }),
      }
    );

    const data = await resp.json();
    const texto =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Desculpe, tive um problema ao responder.";
    return { modelo: "GEMINI", texto };
  } catch (err) {
    console.error("Erro ao chamar Gemini:", err);
    return null;
  }
}

async function chamarClaude(prompt) {
  if (!ANTHROPIC_API_KEY) {
    console.warn("⚠️ ANTHROPIC_API_KEY não encontrada. Ignorando Claude.");
    return null;
  }

  try {
    console.log("🤖 Chamando Claude Sonnet 4.6...");
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
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    const data = await resp.json();
    const texto =
      data?.content?.[0]?.text ||
      "Desculpe, tive um problema ao responder.";
    return { modelo: "CLAUDE", texto };
  } catch (err) {
    console.error("Erro ao chamar Claude:", err);
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
    console.log(`⚖️ Tipo de mensagem: ${tipo}`);

    let respostaIA = null;

    if (tipo === "simples") {
      respostaIA = await chamarGemini(mensagem);
      if (!respostaIA) {
        respostaIA = await chamarClaude(mensagem);
      }
    } else {
      respostaIA = await chamarClaude(mensagem);
      if (!respostaIA) {
        respostaIA = await chamarGemini(mensagem);
      }
    }

    if (!respostaIA) {
      console.error("❌ Nenhum modelo respondeu.");
      return {
        textoLimpo:
          "No momento estou com dificuldades técnicas para responder. Tente novamente em instantes.",
        transferirHumano: false,
      };
    }

    console.log(`✅ Resposta gerada por: ${respostaIA.modelo}`);

    const { textoLimpo, transferirHumano } = analisarTransferencia(
      respostaIA.texto
    );

    return { textoLimpo, transferirHumano };
  } catch (err) {
    console.error("Erro em processarMensagemIA:", err);
    return {
      textoLimpo:
        "Ocorreu um erro ao processar sua mensagem. Tente novamente em alguns instantes.",
      transferirHumano: false,
    };
  }
}
// =========================
// Middleware de autenticação do painel
// =========================
function requireLogin(req, res, next) {
  if (req.session && req.session.logado) {
    return next();
  }
  return res.redirect("/login");
}

// =========================
// Rotas: Login / Logout
// =========================
app.get("/login", (req, res) => {
  const erro = req.query.erro ? "Usuário ou senha inválidos." : "";
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <title>Login - JD Advogados</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #f5f5f5;
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
        }
        .container {
          background: #ffffff;
          padding: 24px 32px;
          border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          width: 320px;
        }
        h1 {
          margin-top: 0;
          font-size: 20px;
          text-align: center;
        }
        label {
          display: block;
          margin-top: 12px;
          font-size: 14px;
        }
        input[type="text"],
        input[type="password"] {
          width: 100%;
          padding: 8px;
          margin-top: 4px;
          border-radius: 4px;
          border: 1px solid #ccc;
          box-sizing: border-box;
        }
        button {
          margin-top: 16px;
          width: 100%;
          padding: 10px;
          background: #1e88e5;
          color: #fff;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
        }
        button:hover {
          background: #1565c0;
        }
        .erro {
          color: #c62828;
          font-size: 13px;
          margin-top: 8px;
          text-align: center;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Painel JD Advogados</h1>
        <form method="POST" action="/login">
          <label for="usuario">Usuário</label>
          <input type="text" id="usuario" name="usuario" required />

          <label for="senha">Senha</label>
          <input type="password" id="senha" name="senha" required />

          <button type="submit">Entrar</button>
          ${
            erro
              ? `<div class="erro">${erro}</div>`
              : `<div style="margin-top:8px;font-size:12px;color:#777;text-align:center;">
                  Usuário: <strong>${ADMIN_USER}</strong><br/>
                  Senha: <strong>${ADMIN_PASS}</strong>
                 </div>`
          }
        </form>
      </div>
    </body>
    </html>
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
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// =========================
// Rota: QR Code para o painel
// =========================
app.get("/qr", requireLogin, (req, res) => {
  if (!ultimoQR) {
    return res.send(`
      <div style="font-family:Arial;padding:20px;">
        <h3>Aguardando geração do QR Code...</h3>
        <p>Se o QR não aparecer em alguns segundos, clique em "Redeploy" no Railway para reiniciar o bot.</p>
      </div>
    `);
  }

  res.send(`
    <div style="font-family: monospace; white-space: pre; padding: 20px;">
${ultimoQR}
    </div>
  `);
});

// =========================
// Rota: Dashboard (só libera painel completo após conexão)
// =========================
app.get("/dashboard", requireLogin, (req, res) => {
  const transferencias = carregarTransferencias().sort(
    (a, b) => new Date(b.criadoEm) - new Date(a.criadoEm)
  );

  // Se ainda existe QR, significa que NÃO conectou ainda → mostra só a tela de conexão
  if (ultimoQR) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <title>Conectar WhatsApp - JD Advogados</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background: #f5f5f5;
            margin: 0;
            padding: 0;
          }
          header {
            background: #1e88e5;
            color: #fff;
            padding: 16px 24px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          header h1 {
            margin: 0;
            font-size: 20px;
          }
          header a {
            color: #fff;
            text-decoration: none;
            font-size: 14px;
          }
          main {
            padding: 24px;
          }
          iframe {
            background: #fff;
            border-radius: 8px;
          }
        </style>
      </head>
      <body>
        <header>
          <h1>Conectar WhatsApp - JD Advogados</h1>
          <a href="/logout">Sair</a>
        </header>
        <main>
          <h2>QR Code do WhatsApp</h2>
          <p>Escaneie o QR abaixo com o WhatsApp do escritório para conectar o bot.</p>
          <iframe src="/qr" style="width:100%;height:260px;border:1px solid #ccc;border-radius:6px;"></iframe>
          <p style="margin-top:16px;color:#555;font-size:13px;">
            Assim que o WhatsApp conectar, esta tela será substituída pelo painel de transferências.
          </p>
        </main>
      </body>
      </html>
    `);
  }

  // Se NÃO há QR, consideramos que o WhatsApp está conectado → mostra painel completo
  const linhas = transferencias
    .map((t) => {
      const data = new Date(t.criadoEm).toLocaleString("pt-BR");
      const statusCor = t.status === "pendente" ? "#c62828" : "#2e7d32";
      const statusTexto = t.status === "pendente" ? "Pendente" : "Atendido";

      return `
        <tr>
          <td>${t.id}</td>
          <td>${t.nome}</td>
          <td>${t.numero}</td>
          <td>${data}</td>
          <td>${t.mensagem}</td>
          <td>${t.motivo}</td>
          <td style="color:${statusCor};font-weight:bold;">${statusTexto}</td>
          <td>
            ${
              t.status === "pendente"
                ? `<form method="POST" action="/transferencias/${t.id}/atender" style="margin:0;">
                     <button type="submit">Marcar como atendido</button>
                   </form>`
                : "-"
            }
          </td>
        </tr>
      `;
    })
    .join("");

  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <title>Dashboard - JD Advogados</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #f5f5f5;
          margin: 0;
          padding: 0;
        }
        header {
          background: #1e88e5;
          color: #fff;
          padding: 16px 24px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        header h1 {
          margin: 0;
          font-size: 20px;
        }
        header a {
          color: #fff;
          text-decoration: none;
          font-size: 14px;
        }
        main {
          padding: 24px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          background: #fff;
          border-radius: 8px;
          overflow: hidden;
        }
        th, td {
          padding: 8px 10px;
          border-bottom: 1px solid #eee;
          font-size: 13px;
          vertical-align: top;
        }
        th {
          background: #f0f0f0;
          text-align: left;
        }
        tr:hover {
          background: #fafafa;
        }
        button {
          padding: 6px 10px;
          background: #2e7d32;
          color: #fff;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }
        button:hover {
          background: #1b5e20;
        }
      </style>
    </head>
    <body>
      <header>
        <h1>Painel de Transferências - JD Advogados</h1>
        <a href="/logout">Sair</a>
      </header>
      <main>
        <p style="color:#2e7d32;font-size:13px;margin-top:0;">
          WhatsApp conectado. Abaixo estão as transferências solicitadas pela IA.
        </p>
        <h2>Transferências solicitadas pela IA</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Nome</th>
              <th>Número</th>
              <th>Data/Hora</th>
              <th>Mensagem</th>
              <th>Motivo</th>
              <th>Status</th>
              <th>Ação</th>
            </tr>
          </thead>
          <tbody>
            ${
              linhas ||
              `<tr><td colspan="8">Nenhuma transferência registrada.</td></tr>`
            }
          </tbody>
        </table>
      </main>
    </body>
    </html>
  `);
});
// =========================
// Rota: Marcar transferência como atendida
// =========================
app.post("/transferencias/:id/atender", requireLogin, (req, res) => {
  const { id } = req.params;
  const ok = marcarTransferenciaComoAtendida(id);
  if (!ok) {
    console.warn(
      `Não foi possível marcar transferência ${id} como atendida.`
    );
  }
  res.redirect("/dashboard");
});

// =========================
// Rota básica de saúde
// =========================
app.get("/", (req, res) => {
  res.send("Bot JD Advogados rodando. Acesse /login para o painel.");
});

// =========================
// Inicialização
// =========================
app.listen(PORT, () => {
  console.log(`🚀 Servidor Express rodando na porta ${PORT}`);
});

iniciarWhatsApp().catch((err) => {
  console.error("Erro ao iniciar WhatsApp:", err);
});
