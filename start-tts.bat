@echo off
setlocal
cd /d "%~dp0.gsv\GPT-SoVITS"
set "HF_ENDPOINT=https://hf-mirror.com"
set "NLTK_DATA=%~dp0.gsv\nltk_data"
set "PYTHONUTF8=1"
echo [tts] 启动 GPT-SoVITS API 127.0.0.1:9880 ...
"%~dp0.gsv\venv\Scripts\python.exe" api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
echo [tts] 已退出，按任意键关闭
pause >nul
