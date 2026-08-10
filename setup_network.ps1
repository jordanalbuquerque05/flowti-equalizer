$ErrorActionPreference = "Stop"
try {
    Write-Host "Aguarde, configurando o roteamento do WSL2..." -ForegroundColor Yellow
    
    # Remove porta antiga se existir para evitar conflito
    netsh interface portproxy delete v4tov4 listenport=8080 listenaddress=0.0.0.0 | Out-Null

    $wsl_ip = (wsl -e hostname -I).Split(' ')[0]
    
    if (-not $wsl_ip) {
        Write-Host "Não foi possível encontrar o IP do WSL." -ForegroundColor Red
        Read-Host "Pressione ENTER para sair"
        exit
    }
    
    Write-Host "IP do WSL encontrado: $wsl_ip" -ForegroundColor Cyan

    Write-Host "Criando ponte de rede (PortProxy) da porta 8080 do Windows para $wsl_ip..."
    netsh interface portproxy add v4tov4 listenport=8080 listenaddress=0.0.0.0 connectport=8080 connectaddress=$wsl_ip
    
    Write-Host "Garantindo regra no Firewall do Windows..."
    New-NetFirewallRule -DisplayName "Equalizador App Port 8080" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
    
    Write-Host "=========================================" -ForegroundColor Green
    Write-Host "SUCESSO! A rede externa já deve conseguir acessar a aplicação." -ForegroundColor Green
    Write-Host "=========================================" -ForegroundColor Green
} catch {
    Write-Host "Ocorreu um erro: $_" -ForegroundColor Red
}
Write-Host ""
Read-Host "Pressione ENTER para fechar esta janela"
