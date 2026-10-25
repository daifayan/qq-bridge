@echo off
rem 启动桌面端 DSH runtime（端口 43129），DSH_HOME 指向 dsh-desktop 的 harness。
rem 桥接（config.json baseUrl=http://127.0.0.1:43129）启动顺序：先本脚本，再启动桥接。
cd /d F:\ai\qq-bridge
"C:\Users\hzm10\AppData\Local\Doubao\User Data\sandbox_runtime\bases\c98c5042338ed152c6f10ecd8591889f\node\node.exe" start-desktop-runtime.mjs
