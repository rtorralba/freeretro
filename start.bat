@echo off
REM Arranca un servidor web local para FreeRetro (sitio 100%% estatico).
REM Uso: start.bat [puerto]   (por defecto 8080)
cd /d "%~dp0"
set PORT=%1
if "%PORT%"=="" set PORT=8080

echo FreeRetro disponible en http://localhost:%PORT% (Ctrl+C para detener)

where py >nul 2>nul
if %errorlevel%==0 (
  py -m http.server %PORT%
  goto :eof
)
where python >nul 2>nul
if %errorlevel%==0 (
  python -m http.server %PORT%
  goto :eof
)
where npx >nul 2>nul
if %errorlevel%==0 (
  npx --yes http-server -p %PORT% -c-1
  goto :eof
)
echo Error: se necesita Python o Node.js (npx) para arrancar el servidor.
pause
