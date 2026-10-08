@echo off
setlocal
chcp 65001 >nul
set "AUDITORIA_ROOT=%~dp0"

if not exist "%AUDITORIA_ROOT%intranet\server.py" (
    echo No se encuentra intranet\server.py.
    echo Extrae el ZIP completo y conserva sus carpetas antes de iniciar.
    pause
    exit /b 1
)

where py >nul 2>nul
if not errorlevel 1 (
    py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
    if not errorlevel 1 goto ejecutar_py
)

where python >nul 2>nul
if not errorlevel 1 (
    python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
    if not errorlevel 1 goto ejecutar_python
)

echo Se necesita Python 3.10 o posterior para compartir la auditoria.
echo Descargalo desde https://www.python.org/downloads/windows/
echo Al instalarlo, activa Add python.exe to PATH.
echo Despues vuelve a abrir este archivo.
pause
exit /b 1

:ejecutar_py
echo Direccion predeterminada: http://127.0.0.1:8080/
echo Conserva esta ventana abierta mientras tus companeros usan la aplicacion.
py -3 "%AUDITORIA_ROOT%intranet\server.py" --host 0.0.0.0 --port 8080 %*
goto terminado

:ejecutar_python
echo Direccion predeterminada: http://127.0.0.1:8080/
echo Conserva esta ventana abierta mientras tus companeros usan la aplicacion.
python "%AUDITORIA_ROOT%intranet\server.py" --host 0.0.0.0 --port 8080 %*

:terminado
set "AUDITORIA_RESULTADO=%ERRORLEVEL%"
echo.
echo El servicio de auditoria se ha detenido.
pause
exit /b %AUDITORIA_RESULTADO%
