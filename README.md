# 将棋解析アプリ Prototype

React + TypeScript + Vite ベースの将棋解析プロトタイプです。

## いまのおすすめ運用

**まずは Android も PWA で使うのが正解寄りです。**

理由:
- Android Studio なしですぐ使える
- 更新反映が速い
- 今の機能セットと相性がいい
- 棋譜再生、盤面確認、軽量解析なら十分実用域

## できること

- KIF / KI2 / CSA / テキスト棋譜の読込
- 棋譜再生
- 盤面での試し指し
- ローカル保存
- 端末内の本格エンジン解析 (zshogi)
- 端末内の実探索解析
- 軽量解析フォールバック
- PWA としてホーム画面追加
- Capacitor で Android / iOS ネイティブ化する土台

## Android での使い方

### PWAとして使う

1. このアプリを Chrome で開く
2. 右上メニューを開く
3. **ホーム画面に追加** を選ぶ
4. 追加後はアプリっぽく全画面で起動できる

### PWA版の特徴

- 初回表示後はキャッシュが効く
- ローカル保存された状態を維持しやすい
- 軽い用途ならネイティブ化しなくても十分

## いまのモバイル方針

このアプリは Android / iOS 単体実行を想定して調整済みです。
ただし、以下はネイティブ単体版では使いません。

- `/api/usi-analyze`
- `/api/usi-test`
- `/api/shogiwars-search`
- `/api/shogiwars-import`

これらは Vite 開発サーバー依存なので、ネイティブ版では自動で無効化されます。

その代わり、単体版やPWA版では以下を中心に使う構成です。

- KIF / CSA 読み込み
- 盤面操作
- 候補手表示
- 端末内の実探索解析
- より強い将来版WASM解析への拡張

## 開発

```bash
npm install
npm run dev
```

## Webビルド

```bash
npm run build
npm run preview
```

## Android / iOS ネイティブ化

必要になったら使う手順です。

### 初回のみ

```bash
npx cap add android
npx cap add ios
```

### 同期

```bash
npm run cap:sync
```

### Android

```bash
npm run cap:android
```

### iOS

```bash
npm run cap:ios
```

## 注意

- iOS ビルドには macOS + Xcode が必要
- Android ビルドには Android Studio が必要
- いまの USI ブリッジは PC 向け機能
- 将棋ウォーズ取得も開発サーバー依存なので単体版ではオフ

## 解析について

いまの `wasm` モードは、まず `zshogi` を使った端末内の本格エンジン解析を試します。
もし環境依存でうまく動かない場合だけ、自前の軽量探索へフォールバックします。

特徴:
- ブラウザ内だけで動く
- Android PWA と相性がいい
- 通信なしでも読める
- まず zshogi を使う (必要時に遅延読込)
- 読みの深さは端末性能と設定時間に応じて調整
- 解析は Worker 優先で回すのでUIが引っかかりにくい
- 古い解析結果は捨て、再解析は軽くデバウンスしている

## 次にやると強い

- zshogi の Worker 内実行対応
- SFEN 直解析でも zshogi 優先化
- PWA用の更新通知改善
- オフライン時の案内をもう少し丁寧にする
- ネイティブファイルピッカー統合
