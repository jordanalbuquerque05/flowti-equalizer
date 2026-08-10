$ErrorActionPreference = "Continue"

Write-Host "Tentando iniciar a aplicacao via Docker..." -ForegroundColor Cyan

function Try-Docker {
    $dockerComposeCmd = Get-Command "docker" -ErrorAction SilentlyContinue
    if ($dockerComposeCmd) {
        docker compose up -d --build 2>$null
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    
    $dockerComposeOldCmd = Get-Command "docker-compose" -ErrorAction SilentlyContinue
    if ($dockerComposeOldCmd) {
        docker-compose up -d --build 2>$null
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    return $false
}

function Try-WSL-Docker {
    wsl docker compose up -d --build 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
    wsl docker-compose up -d --build 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
    return $false
}

# Tenta Docker local (se estiver rodando)
if (Try-Docker) {
    Write-Host "Aplicacao iniciada via Docker com sucesso! (http://localhost:8080)" -ForegroundColor Green
    exit 0
}

Write-Host "Docker daemon desligado ou inacessivel. Tentando ligar..." -ForegroundColor Yellow

# Tenta ligar Docker Desktop no Windows
$dockerDesktopPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
if (Test-Path $dockerDesktopPath) {
    Write-Host "Iniciando Docker Desktop no Windows..." -ForegroundColor Cyan
    Start-Process $dockerDesktopPath
    Write-Host "Aguardando 15 segundos..."
    Start-Sleep -Seconds 15
    if (Try-Docker) {
        Write-Host "Aplicacao iniciada via Docker Desktop com sucesso! (http://localhost:8080)" -ForegroundColor Green
        exit 0
    }
} else {
    # Tenta ligar servico docker no WSL
    Write-Host "Iniciando daemon Docker no WSL..." -ForegroundColor Cyan
    wsl -u root sh -c "nohup dockerd > /dev/null 2>&1 &"
    Write-Host "Aguardando 5 segundos..."
    Start-Sleep -Seconds 5
    if (Try-WSL-Docker) {
        Write-Host "Aplicacao iniciada via WSL Docker com sucesso! (Acesse usando o IP do WSL)" -ForegroundColor Green
        exit 0
    }
}

Write-Host "Nao foi possivel iniciar o Docker. Acionando o modo fallback (Nativo com Node.js)..." -ForegroundColor Magenta

Write-Host "Verificando dependencias do NPM..." -ForegroundColor Cyan
cmd /c npm install

Write-Host "Iniciando servidor Node.js nativamente..." -ForegroundColor Green
node server.js
