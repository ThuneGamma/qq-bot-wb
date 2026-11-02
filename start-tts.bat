@echo off
setlocal
cd /d "%~dp0.gsv\GPT-SoVITS"
if errorlevel 1 goto :nofolder
set "HF_ENDPOINT=https://hf-mirror.com"
set "NLTK_DATA=%~dp0.gsv\nltk_data"
set "PYTHONUTF8=1"
echo [tts] starting GPT-SoVITS API on 127.0.0.1:9880 ...
echo [tts] first start loads the model, wait for "Uvicorn running on http://127.0.0.1:9880"
echo.
"%~dp0.gsv\venv\Scripts\python.exe" api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
echo.
echo [tts] exited with code %errorlevel%
pause
exit /b 0

:nofolder
echo [tts] ERROR: .gsv\GPT-SoVITS not found under "%~dp0"
echo [tts] expected: %~dp0.gsv\GPT-SoVITS
pause
exit /b 1
