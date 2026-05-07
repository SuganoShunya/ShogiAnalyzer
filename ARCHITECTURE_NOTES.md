# 将棋解析アプリ 試作メモ

## 現在の運用前提
- UI は React / Vite の PWA
- 実用構成は `PCにUSIエンジン`, `スマホはUI` が前提
- USI未接続時は軽量フォールバック解析で継続利用可能

## いまの解析レイヤ
- `src/engine.ts`
  - アプリ側の統一入口
  - USIが使えればUSI結果を返す
  - 失敗時は mock へフォールバック
- `src/usi.ts`
  - `/api/usi-analyze` へ問い合わせるクライアント
- `vite.config.ts`
  - dev server 上で USI プロセスを起動する簡易APIを提供

## 次の分岐候補
### 1. PCローカル中継を強化
- 接続テストボタン
- エンジン起動失敗ログ表示
- ローカルIP案内
- LAN公開手順のUI化

### 2. 解析レイヤの抽象化
将来は provider 化したい。

候補:
- `mock`
- `usi-local-bridge`
- `wasm-engine`
- `remote-api`

理想形:
- `analyzePosition()` は provider を選ぶだけ
- UIは provider 差を意識しない

### 3. モバイル完全対応の方向
- iOS / Android 直実行は厳しい
- 本命は `WASM engine` か `remote-api`
- 深い解析だけPC/サーバーへ逃がすハイブリッドも有力

## 優先順
1. PCローカル中継の運用性改善
2. provider 分離
3. 接続テストとエラーメッセージ改善
4. WASM / remote API 検討
