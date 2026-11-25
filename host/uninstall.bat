@echo off
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ytdl.helper" /f >nul 2>nul
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.ytdl.helper" /f >nul 2>nul
del "%~dp0com.ytdl.helper.json" >nul 2>nul
echo Helper unregistered.
pause
