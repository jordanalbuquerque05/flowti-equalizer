$ErrorActionPreference = "Stop"
try {
    Write-Host "Aguarde, configurando o roteamento do WSL2..." -ForegroundColor Yellow
    
    # Remove porta antiga se existir para evitar conflito
    netsh interface portproxy delete v4tov4 listenport=3000 listenaddress=0.0.0.0 | Out-Null

    $wsl_ip = (wsl -e hostname -I).Split(' ')[0]
    
    if (-not $wsl_ip) {
        Write-Host "Não foi possível encontrar o IP do WSL." -ForegroundColor Red
        Read-Host "Pressione ENTER para sair"
        exit
    }
    
    Write-Host "IP do WSL encontrado: $wsl_ip" -ForegroundColor Cyan

    Write-Host "Criando ponte de rede (PortProxy) da porta 3000 do Windows para $wsl_ip..."
    netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=$wsl_ip
    
    Write-Host "Garantindo regra no Firewall do Windows..."
    New-NetFirewallRule -DisplayName "Equalizador App Port 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
    
    Write-Host "=========================================" -ForegroundColor Green
    Write-Host "SUCESSO! A rede externa já deve conseguir acessar a aplicação." -ForegroundColor Green
    Write-Host "=========================================" -ForegroundColor Green
} catch {
    Write-Host "Ocorreu um erro: $_" -ForegroundColor Red
}
Write-Host ""
Read-Host "Pressione ENTER para fechar esta janela"
