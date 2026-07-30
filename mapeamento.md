# Mapeamento do Sistema - FlowtiEqualizerOps

Este documento descreve os principais diretórios e caminhos nos quais o sistema se baseia nas máquinas remotas (PRD e TST) para gerenciar, consultar e atualizar os produtos.

## 1. Diretórios de Aplicações (Releases)
Os arquivos físicos das aplicações (HTML, classes, forms, etc.) ficam hospedados nos seguintes caminhos, dependendo do ambiente:

- **Produção (PRD):** 
  `/MV/apps/soulmv_prd/products/`
- **Teste / Treinamento (TST/TRN):** 
  `/MV/apps/soulmv_trn/products/`

**Estrutura Padrão:**
As releases ficam dentro desses diretórios seguindo o formato: 
`/MV/apps/<ambiente>/products/<produto>/<versao_release>/`

> **Nota na Cópia PRD -> TST:** Quando acionado, o sistema pega a pasta de release do produto no diretório de PRD e a transfere via *tar pipe* para a respectiva pasta em TST, copiando também o subdiretório `conf/` da versão antiga de TST para a nova.

---

## 2. Configurações do Tomcat (XMLs e Contexto)
O sistema lê e modifica os arquivos XML de contexto do Tomcat para apontar para a release correta.

- **Arquivos de Contexto XML:** 
  `/MV/servers/<targetDir>/<tomcat_name>/conf/Catalina/localhost/<produto>.xml`
  *(Onde o sistema altera a propriedade `docBase` para apontar para a nova versão da release).*
- **Script de Inicialização do Tomcat:** 
  `/etc/init.d/<tomcat>`
  *(Usado durante a sincronização de release para coletar/atualizar a variável `CATALINA_HOME`).*
- **Versão do Tomcat:**
  `/MV/servers/*/<tomcat>/conf/tomcat-version.txt`
  *(Sincronizado entre as máquinas ao realizar a cópia de ambiente).*

---

## 3. Backups e Rollback Automático
Sempre que uma atualização de versão (troca de XML) é feita pelo Equalizer, ele salva o XML antigo como medida de segurança.

- **Diretório de Backup:** 
  `/MV/flowtiequalizer/`
  *(Os arquivos salvos têm um timestamp anexado, permitindo o Rollback imediato pela interface caso necessário).*

---

## 4. Arquivos Específicos e Dependências
- **MVAuTenticador-CAS (Banco de Dados):**
  `/MV/apps/<dir>/products/mvautenticador-cas/<RELEASE>/conf/db.properties`
  *(O sistema varre este caminho especificamente para checar as conexões de banco das configurações de autenticação).*

---

## 5. Diretório Local (Servidor Node)
Na máquina onde este servidor (EqualizerOps) roda localmente:
- **`inventario_geral_maquinas.json`**: Funciona como a base de dados em cache dos clientes, BALs e máquinas APP caso o banco de dados principal (OCI MySQL) não esteja acessível. É vital para popular a lista de clientes.
- **`.env`**: Guarda as chaves e credenciais SSH (configuradas dinamicamente de acordo com a _tenancy_ e a _jump host_ de cada cliente).

---

## 6. Funcionalidades e Ações (Botões da Interface)

A interface possui botões de ações operacionais. Abaixo está o detalhamento técnico do que o backend do Node.js executa por trás dos panos em servidores Linux remotamente:

- **Atualizar selecionados em TST**
  - *Finalidade:* Atualiza as versões (apontamento do XML) de vários produtos simultaneamente nos ambientes alvo.
  - *Como funciona:* O Node abre um túnel SSH, entra na máquina alvo, cria uma pasta com a data/hora atual dentro de `/MV/flowtiequalizer/`. Faz uma cópia de segurança do XML atual e usa o comando `sed` para alterar o `docBase` desse XML para apontar para o novo diretório da release. Tudo validado antes para garantir que as pastas das novas releases existam fisicamente.

- **📥 Copiar do PRD**
  - *Finalidade:* Sincroniza/Copia a pasta de uma release que está rodando em PRD para dentro da máquina de TST.
  - *Como funciona:* Lê as variáveis de `CATALINA_HOME` e diretórios. Gera um stream comprimido dos arquivos de PRD via *tar pipe* direto para a TST. Após a transferência da pasta da release, copia os arquivos da sub-pasta `conf/` da release antiga de TST para a recém-chegada release. Finaliza ajustando as permissões com `chown` para o usuário do Tomcat.

- **⏪ Rollback**
  - *Finalidade:* Reverte uma atualização recém-executada.
  - *Como funciona:* Utiliza a mesma conexão SSH em lote para copiar o arquivo XML que foi guardado na pasta `/MV/flowtiequalizer/<DATA_HORA>` de volta para `/MV/servers/.../conf/Catalina/localhost/<produto>.xml`, sobrepondo a atualização anterior e restaurando a versão antiga.

- **🔄 Restart Tomcat**
  - *Finalidade:* Reinicia o serviço Tomcat daquele produto.
  - *Como funciona:* Dispara remotamente o comando de serviço equivalente a `sudo /etc/init.d/<tomcat> restart` ou executa o `shutdown.sh` e `startup.sh` se disponível, reinicializando a instância para que as modificações de XML tenham efeito de imediato na aplicação web.
