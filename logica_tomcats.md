# Lógica de Controle dos Tomcats (Parar, Limpar e Iniciar)

A lógica implementada no sistema para o controle das instâncias do Tomcat está centralizada na API PHP (`public/api/api.php`), mais especificamente na ação `run_tomcat_actions`.

## 1. Recepção da Requisição e Configuração de Streaming
O frontend envia uma requisição via método `POST` contendo um payload em JSON. O payload especifica:
- `ip`: IP do servidor alvo.
- `tomcats`: Um array contendo os IDs dos Tomcats nos quais as ações serão executadas (ex: `[1, 2]`).
- `actions`: Um array ordenado com as ações a serem executadas sequencialmente (ex: `['stop', 'cleanup', 'start', 'log']`).

O PHP imediatamente desativa o *output buffering* e define os cabeçalhos apropriados (como `X-Accel-Buffering: no` e `ob_implicit_flush(1)`) para permitir o **Streaming de Dados**. Dessa forma, o backend consegue enviar mensagens JSON parciais para o cliente em tempo real a cada comando executado, utilizando a combinação de `echo` e `flush()`.

## 2. Iteração e Definição de Comandos
Para cada ID de Tomcat (ex: `tomcatId = 1`) presente no array enviado, o script itera sobre as ações requeridas. Os comandos no nível do sistema operacional são construídos para chamar o utilitário/script shell `tomcatctl` do servidor:
- **Parar (`stop`)**: O comando construído é `tomcatctl stop $tomcatId`.
- **Limpar (`cleanup`)**: O comando construído é `tomcatctl cleanup $tomcatId`.
- **Iniciar (`start`)**: O comando construído é `tomcatctl start $tomcatId`.
- **Logs (`log`)**: É executado um `tail -n 200 -f` no arquivo `catalina.out` correspondente (ex: `/MV/servers/*/tomcat1/logs/catalina.out`).

## 3. Modos de Execução (Gateway vs Local)
Para acessar a máquina alvo e efetivamente rodar os comandos `tomcatctl`, o sistema verifica se deve usar um Gateway ou uma conexão direta:

### Modo Gateway (Acesso Remoto/Indireto)
Se o sistema resolver uma URL de Gateway para o ambiente (`tenancy` ou IP informados):
1. O backend não se conecta via SSH diretamente à máquina.
2. É feita uma requisição `cURL` internamente para a API do Gateway (`$gatewayUrl/api/api_agent.php?step=run_tomcat_action`), repassando o comando e o IP da máquina destino.
3. Para manter o streaming funcionando, a função `CURLOPT_WRITEFUNCTION` do cURL é utilizada: toda vez que o Gateway retorna um pedaço de log (chunk), o backend imediatamente o repassa (dá `echo` e `flush`) de volta ao frontend.

### Modo Local (Conexão SSH Direta)
Se não existir um Gateway:
1. O PHP estabelece uma conexão **SSH** direta com o IP alvo (`ssh2_connect`) na porta padrão configurada.
2. Ele se autentica testando as credenciais globais e pré-configuradas em constantes (`SSH_USER`, `SSH_PASS_1`, `SSH_PASS_2`).
3. Uma vez conectado, ele dispara os comandos de forma sequencial na sessão e envia as transições (logs de sucesso/falha de cada etapa) pelo streaming.

## Conclusão
A arquitetura foi modelada para ser assíncrona para o usuário (via SSE/Streaming PHP) de forma a mostrar logs precisos de etapas que são demoradas (como parar ou subir um Tomcat pesado). O encapsulamento dos comandos ocorre através do executável `tomcatctl`, e as ações suportam distribuição distribuída atravessando proxies (Gateway Mode) ou diretamente via SSH PHP nativo (Local Mode).
