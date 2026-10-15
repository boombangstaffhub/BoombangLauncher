@echo off
cd /d "%~dp0"
if not exist node_modules\electron (
  echo Instalando Electron la primera vez...
  call npm install
)
call npm start
