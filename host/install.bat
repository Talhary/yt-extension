@echo off
rem One-time setup: registers the download helper with Chrome and Edge.
rem After this, the browser starts the helper by itself - nothing to run manually.
setlocal
set "DIR=%~dp0"
set "MANIFEST=%DIR%com.ytdl.helper.json"
set "BAT=%DIR%run_host.bat"

> "%MANIFEST%" echo {
>> "%MANIFEST%" echo   "name": "com.ytdl.helper",
>> "%MANIFEST%" echo   "description": "YT Downloader helper",
>> "%MANIFEST%" echo   "path": "%BAT:\=\\%",
>> "%MANIFEST%" echo   "type": "stdio",
>> "%MANIFEST%" echo   "allowed_origins": ["chrome-extension://lahpanickelhfkjjmcajellkekddgodh/"]
>> "%MANIFEST%" echo }

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ytdl.helper" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.ytdl.helper" /ve /t REG_SZ /d "%MANIFEST%" /f >nul

where python >nul 2>nul || echo WARNING: python not found on PATH
where yt-dlp >nul 2>nul || echo WARNING: yt-dlp not found - run: pip install -U yt-dlp
where ffmpeg >nul 2>nul || echo WARNING: ffmpeg not found - run: winget install Gyan.FFmpeg

echo Helper registered. Reload the extension in chrome://extensions.
pause
