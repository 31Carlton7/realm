@echo off
rem realm: Realm's command line on Windows; ./realm says how it finds what to run. From an installed
rem Realm (resources\bin or resources\server\bin) it runs on Realm.exe as Node; from a checkout, on node.
setlocal
set "server=%~dp0.."
if not exist "%server%\dist\realm.js" set "server=%~dp0..\server"
set "app=%server%\..\..\Realm.exe"
if exist "%server%\..\app.asar" if exist "%app%" goto app
node "%server%\dist\realm.js" %*
exit /b %errorlevel%
:app
set ELECTRON_RUN_AS_NODE=1
"%app%" "%server%\dist\realm.js" %*
exit /b %errorlevel%
