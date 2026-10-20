# 場次收銀機 v74

完整靜態網站：`index.html` 已包含應用程式 JavaScript 與樣式；同目錄附有 `sw.js`、網站圖示、字型、付款 QR 圖及 PWA manifest。使用方式詳見 [使用說明.md](使用說明.md)。

## 下載及執行

在此分支點 **Code → Download ZIP**，解壓後保留檔案相對路徑。可部署至靜態網站，或在此目錄執行 `python3 -m http.server 8000`，以瀏覽器開啟 `http://localhost:8000`。更新現有網站前，請先從收銀機匯出完整 JSON 備份；沿用原網站網址才能讀取原瀏覽器資料。

v74 將「會員資料」移至「場次統計」下方並改為獨立頁面。列表順序為「編號｜署名｜累計金額｜最近一筆購買紀錄」，點選會員後顯示「日期 時間｜品項｜金額」完整消費紀錄。保留 v73 莫蘭迪配色與多筆折扣功能。

## 選用功能與測試

- `SUPABASE_SETUP.txt`：選用雲端同步設定說明。
- `sms-example/`：選用簡訊後端範例，不包含實際服務商憑證；GitHub Pages 不會執行此後端。
- `tests/`：Chromium／Playwright 測試，預設連線至 `http://127.0.0.1:8000`，需另外安裝 Playwright 與 Chromium。

此分支不含 ZIP 包、密鑰、憑證或工作區環境設定。
