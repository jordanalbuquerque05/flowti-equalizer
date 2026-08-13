# Versão Estável 13-08-2026 - Documentação Completa (Equalizer Ops)

Este documento foi criado para servir como um **Blueprint (Projeto Matriz)** do sistema **Equalizer Ops**. Ele contém toda a lógica, o fluxo de dados, a arquitetura e o funcionamento da interface.

Se este arquivo for passado para uma Inteligência Artificial com o comando *"Crie esta aplicação"*, a IA deverá ser capaz de reconstruir o sistema inteiro em um ambiente de homologação, com as exatas mesmas funcionalidades que temos hoje na branch `main` (Tag `versao_estavel_13-08-2026_oficial`).

---

## 1. Visão Geral da Arquitetura

O **Equalizer Ops** é um painel de controle e auditoria focado em monitorar e extrair versões de aplicações web (Tomcats) hospedadas nas máquinas SOUL, que geralmente estão em redes privadas acessíveis apenas via servidores de salto (BALs).

### Stack Tecnológica:
- **Backend**: `Node.js` (Express.js, pacotes: `ssh2`, `mysql2`, `dotenv`, `cors`).
- **Frontend**: `HTML5`, `CSS3` (Vanilla com CSS Variables e tema Dark), `JavaScript` (Vanilla, API Fetch para streaming).
- **Banco de Dados OCI**: `MySQL` via pool de conexões (porta 33060).
- **Persistência de Arquivos**: 
  - `inventario_geral_maquinas.json`: Carregado na inicialização para popular a base de máquinas.
  - `tomcat_cache.json`: Gravado pelo backend para salvar a relação (IP -> Produto -> Tomcat) de forma persistente.

---

## 2. Estrutura e Fluxo do Sistema

### 2.1 Fluxo de Autenticação e Conexão SSH (O Coração do Sistema)
Como a aplicação atinge máquinas inacessíveis publicamente, ela executa uma **Cadeia de SSH (SSH Tunneling)**:
1. O Node.js usa a biblioteca `ssh2` para estabelecer uma conexão com o servidor público (BAL). As senhas dos BALs são puxadas das variáveis de ambiente baseadas na `tenancy` do cliente (`SSH_PASS_CLOUDMVORACLE` ou `SSH_PASS_MVCLIENTESAAS`).
2. Uma vez conectado ao BAL (via evento `forwardOut`), o Node abre um túnel TCP direcionado ao IP privado da máquina SOUL alvo (`10.x.x.x` etc) na porta 22.
3. Um segundo cliente `ssh2` é instanciado para conectar na máquina SOUL através desse túnel (Stream).
4. O backend implementa um **Fallback Inteligente (`executeWithBalFallback`)**: Se a conexão falhar por questões de rede, ele varre a lista de todos os BALs do cliente até encontrar uma rota funcional.

### 2.2 Fluxo de Descoberta de Versões (Dynamic CMD)
Em vez de baixar os arquivos ou fazer consultas pesadas, o Node.js envia um comando Shell (`bash`) dinâmico via SSH.
Este comando varre o diretório `/MV/servers/[AMBIENTE]/`, entra em cada Tomcat, lê todos os arquivos `.xml` dentro de `conf/Catalina/localhost/` e aplica expressões regulares (`grep -oP`) para extrair a **versão real** da aplicação (tag `docBase` ou match de versão literal). A resposta é retornada de forma crua pelo SSH (`tomcat|produto|versao`).

### 2.3 Streaming NDJSON
Como o processamento pode demorar quando um cliente tem dezenas de máquinas, o backend NÃO espera tudo terminar. A API usa `Transfer-Encoding: chunked` e retorna um fluxo do tipo **NDJSON (Newline Delimited JSON)**. O Frontend usa um leitor assíncrono (Web Streams API) para renderizar o progresso na tela do usuário, máquina por máquina, ao vivo.

---

## 3. Interface e Lógica dos Botões (Frontend)

O painel foi construído no formato "Dashboard" lateral com painéis centrais dinâmicos.

### 3.1 Painel Lateral de Clientes
- **Barra de Pesquisa**: Filtra clientes em tempo real pelo código ou parte do nome.
- **Card do Cliente**: Ao clicar, o frontend busca no arquivo de inventário todas as máquinas daquele cliente e as renderiza no painel de "Auditoria".

### 3.2 Botões de Ação na Tela Principal
> Estes botões manipulam diretamente as máquinas selecionadas (`checkboxes` azuis em cada card de máquina).

#### 🚀 **Verificação Completa**
- **O que faz**: Roda a cadeia completa nas máquinas SOUL selecionadas para descobrir exatamente o que está instalado. Atualiza a tela de resultados em formato de cards.
- **Fluxo Técnico**: Chama `POST /api/check-versions` enviando o IP do BAL e a lista de máquinas-alvo. O servidor dispara a cadeia SSH, busca os tomcats no diretório `conf/Catalina`, grava o resultado no `tomcat_cache.json` e retorna os dados em streaming.

#### ⚡ **Verificar Versões**
- **O que faz**: Visualmente é muito parecido com a "Verificação Completa", trazendo na tela o sumário dos Tomcats da máquina para rápida visualização em uma tabela (Modal).
- **Fluxo Técnico**: Usa o mesmo endpoint de Full Check, mas a apresentação na interface foca em criar a tabela e salvar o mapa na memória.

#### 📦 **Verificar Releases**
- **O que faz**: Compara de forma visual o que a máquina SOUL diz ter instalado VERSUS o que o Banco de Dados do OCI diz que ela tem.
- **Fluxo Técnico**: O Front end pega o `lastVersionMap` da memória e compara com o conteúdo de banco armazenado em `window.lastDbMap`. Se as versões baterem, fica verde. Se divergirem, cria-se um alerta visual vermelho indicando discrepância de infra vs repositório OCI.

#### 🗄️ **Consultar Banco**
- **O que faz**: Bate exclusivamente no banco de dados OCI (MySQL na porta 33060) para trazer as "versões oficias / releases liberados" atrelados ao cliente. 
- **Fluxo Técnico**: Chama `GET /api/db-versions?codigo=XXXX`. O Node faz o SELECT na tabela do OCI e traz os dados.

#### 🔎 **Consultar Único Produto (Ícone Lupa)**
- **O que faz**: Oculto dentro da tabela de resultados, permite clicar sobre um produto específico, para executar um novo rastreamento e trazer o status individual daquele produto.

#### 🧹 **Limpar Painel**
- **O que faz**: Restaura as "Divs" do painel de auditoria para o Empty State e cancela requisições ativas.

---

## 4. Onde encontrar cada componente:

- **Configurações Sensíveis**: Tudo fica no arquivo `.env` (Senhas do Banco, Senhas SSH `MVCLIENTESAAS` e `CLOUDMVORACLE`). **Nunca** devem ser commitadas no Git.
- **Backend Core**: O arquivo `server.js` é um monolito focado. Todas as rotas (`/api/check-versions`, `/api/db-versions`) e as funções de core de SSH (`sshChainExecCore`, `executeWithBalFallback`) estão nele.
- **Visual & UI**: O arquivo `styles.css` contém todo o Design System (Cores CSS Vars `--accent`, `--bg-surface`, animações de pulse, cards em glassmorphism).
- **Lógica Cliente Web**: `index.html` embute o script que manipula o DOM. A função `renderSoulPanel` constrói as "chips" de máquinas, enquanto as funções assíncronas leem os streams.

---

> **NOTA PARA A INTELIGÊNCIA ARTIFICIAL** 
> 
> Se estiver reconstruindo esta aplicação, certifique-se de configurar o **SSH Client do Node (`ssh2`)** para sempre incluir as chaves de timeout para evitar travamentos (`readyTimeout: 15000`) em ambos os túneis e instanciar um `Stream Reader` no frontend para suportar a arquitetura **NDJSON**, que é indispensável para evitar telas congeladas enquanto se executa auditorias lentas nos data centers. Mantenha fielmente o esquema de leitura via túnel (JumpClient -> ForwardOut -> SoulClient).
