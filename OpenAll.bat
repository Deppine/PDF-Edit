@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"

echo ================================================
echo   PDF Tools - เปิดใช้งานเซิร์ฟเวอร์
echo ================================================
echo.

curl -s -o nul --max-time 1 http://127.0.0.1:8000/ >nul 2>&1
if %errorlevel%==0 (
    echo เซิร์ฟเวอร์ทำงานอยู่แล้วที่พอร์ต 8000 ข้ามขั้นตอนนี้
) else (
    echo กำลังเปิดเซิร์ฟเวอร์ที่พอร์ต 8000 จากโฟลเดอร์นี้...
    start "PDF Tools Server (port 8000)" /D "%ROOT%" cmd /k "python -m http.server 8000"
    timeout /t 2 /nobreak >nul
)

echo กำลังเปิดหน้าเว็บ...
start "" "http://localhost:8000/"

echo.
echo เสร็จแล้ว! หน้าต่างนี้จะปิดเองใน 3 วินาที
echo (อย่าปิดหน้าต่าง "PDF Tools Server (port 8000)" ระหว่างใช้งาน ปิดได้เมื่อเลิกใช้)
timeout /t 3 >nul
