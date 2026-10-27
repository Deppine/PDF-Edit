@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ================================================
echo   Lyra Desktop - สร้างโปรแกรม (.exe) สำหรับ Windows
echo ================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ไม่พบ Node.js กรุณาติดตั้ง Node.js เวอร์ชัน LTS จาก https://nodejs.org แล้วรันไฟล์นี้ใหม่
  pause
  exit /b 1
)

if not exist node_modules (
  echo กำลังติดตั้งแพ็กเกจ ^(ครั้งแรกใช้เวลาสักครู่ ต้องต่ออินเทอร์เน็ต^)...
  call npm install
  if errorlevel 1 goto :err
)

echo.
echo กำลังสร้างโปรแกรม...
call npm run pack
if errorlevel 1 goto :err

echo.
echo เสร็จแล้ว! เปิดโฟลเดอร์ out\Lyra-win32-x64 แล้วดับเบิลคลิก Lyra.exe
explorer "out\Lyra-win32-x64"
pause
exit /b 0

:err
echo.
echo เกิดข้อผิดพลาด ดูข้อความด้านบน
pause
exit /b 1
