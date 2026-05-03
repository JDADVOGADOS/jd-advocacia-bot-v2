JD Advocacia – Assistente Virtual (WhatsApp + IA)
Este projeto é a versão 2.0 do assistente virtual do escritório JD Advocacia, desenvolvido para automatizar atendimentos via WhatsApp utilizando:

Baileys (conexão com WhatsApp)

Gemini (IA principal)

Claude (fallback inteligente)

Balanceamento automático

Modo econômico

Transferência para humano

Servidor web com QR Code

Monitoramento de uptime

Dockerfile otimizado para Railway

🚀 Funcionalidades
Atendimento automático via WhatsApp

Respostas inteligentes com IA

Histórico de conversa por cliente

Modo econômico (mensagens simples → Gemini)

Fallback automático (se Gemini falhar → Claude)

Transferência para humano com notificação

QR Code via servidor web

Monitoramento de uptime

Deploy simples via Docker + Railway

📦 Estrutura do Projeto
Código
/
├── index.js
├── package.json
├── Dockerfile
├── .gitignore
└── (gerado automaticamente) auth_info/
🔧 Tecnologias Utilizadas
Node.js 20+

Baileys

Gemini API

Claude API

Docker

Railway

🔐 Variáveis de Ambiente
Crie um arquivo .env (não enviar para o GitHub):

Código
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=...
ADVOGADO_NUMERO=5599999999999
PORT=8080
No Railway, configure as mesmas variáveis em:

Settings → Variables

🛠️ Como rodar localmente
1. Instale dependências
Código
npm install
2. Inicie o bot
Código
node index.js
3. Abra o navegador
Código
http://localhost:8080
Escaneie o QR Code com o WhatsApp do escritório.

🚀 Deploy no Railway
Crie um novo projeto no Railway

Conecte ao repositório do GitHub

Railway detecta o Dockerfile automaticamente

Configure as variáveis de ambiente

Abra o domínio para escanear o QR Code

🧹 Limpeza automática de histórico
O bot limpa conversas antigas a cada 2 horas.

📡 Monitoramento de Uptime
O bot registra um log a cada 5 minutos:

Código
📡 Uptime check: 03/05/2026 16:31
📘 Melhorias futuras
Dashboard de atendimentos

Logs persistentes

Integração com CRM

Painel administrativo

🧑‍⚖️ Sobre o Escritório
JD Advocacia
Especializado em Direito Empresarial e Tributário
Atendimento: segunda a sexta, 8h às 18h

✔️ Pronto!
Seu README está completo, profissional e pronto para o GitHub.

👉 PRÓXIMO PASSO (se quiser):
Posso te guiar agora para:

🔹 Fazer o deploy no Railway
🔹 Testar o bot em produção
🔹 Configurar logs e monitoramento
🔹 Criar um plano de atualização futura
O que você quer fazer agora?

Eu devo criar o README.md onde? no visual code?
Sim, Julian — você deve criar o README.md diretamente no Visual Studio Code, dentro da pasta do seu projeto meu-bot-wats-vers2.
Vou te explicar exatamente onde clicar e o que fazer, sem complicação.

📌 Onde criar o README.md?
👉 Dentro da pasta do seu projeto, no mesmo nível onde estão:

index.js

package.json

Dockerfile

.gitignore

Ou seja, na raiz do projeto.

🧭 Passo a passo no Visual Studio Code
✔️ 1. Abra o VS Code
Abra a pasta do seu projeto:

File → Open Folder → selecione “meu-bot-wats-vers2”

✔️ 2. No lado esquerdo (Explorer), clique com o botão direito na pasta
Clique em:

New File

✔️ 3. Digite o nome do arquivo exatamente assim:
Código
README.md
⚠️ Tem que ser .md no final (Markdown).

✔️ 4. Cole o conteúdo do README que eu te enviei
Basta colar tudo dentro do arquivo.

✔️ 5. Salve o arquivo
CTRL + S

✔️ 6. Agora envie o README para o GitHub
No terminal, dentro da pasta do projeto:

Código
git add README.md
git commit -m "Adicionando README.md"
git push
Como você já configurou o remote e limpou o histórico, agora o push vai funcionar normalmente.