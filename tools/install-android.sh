#!/bin/sh
# 把 App 裝到所有用 USB 接上、已允許偵錯的手機
adb="$HOME/Library/Android/sdk/platform-tools/adb"
apk="$(dirname "$0")/../android/app/build/outputs/apk/debug/app-debug.apk"

if [ ! -f "$apk" ]; then
  echo "找不到 APK，請先執行 npm run android:build"
  exit 1
fi

devices=$("$adb" devices | awk 'NR>1 && $2=="device" {print $1}')
unauthorized=$("$adb" devices | awk 'NR>1 && $2=="unauthorized" {print $1}')

if [ -n "$unauthorized" ]; then
  echo "有手機還沒允許這台 Mac：請看手機畫面上的「要允許 USB 偵錯嗎？」，勾選「一律允許」後按「允許」"
fi
if [ -z "$devices" ]; then
  [ -z "$unauthorized" ] && echo "沒有偵測到手機。請確認：1) 開發人員選項裡的「USB 偵錯」已開啟 2) 拔掉 USB 線再重插 3) 手機上按「允許」"
  exit 1
fi

for s in $devices; do
  model=$("$adb" -s "$s" shell getprop ro.product.model | tr -d '\r')
  printf '安裝到 %s（%s）… ' "$model" "$s"
  "$adb" -s "$s" install -r "$apk" | tail -1
done
