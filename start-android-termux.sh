#!/data/data/com.termux/files/usr/bin/bash
# Запуск NS Bus прямо на Android-телефоне через Termux (без компьютера).
#   1) Установите Termux из F-Droid: https://f-droid.org/packages/com.termux/
#   2) Скопируйте папку novisad-bus на телефон (например, в Download) и выполните:
#        termux-setup-storage
#        cd ~/storage/downloads/novisad-bus && bash start-android-termux.sh
#   3) Откройте в Chrome: http://localhost:8000  → меню ⋮ → «Добавить на главный экран»
cd "$(dirname "$0")"
command -v python >/dev/null 2>&1 || pkg install -y python
termux-open-url http://localhost:8000 2>/dev/null &
python server.py --host 127.0.0.1 --port 8000
