# Icon Pack

基于 `source/icon-original.png` 使用代码批量生成，未进行手工绘制或重设计。

## 目录结构

```text
icon-pack/
├── source/                       # 原始 PNG 备份
├── png/                          # 通用 PNG：16x16 到 1024x1024 多尺寸
├── ios/AppIcon.appiconset/        # iOS / iPadOS App Icon，可直接拖入 Xcode Assets
├── android/mipmap-*/              # Android launcher icon，mdpi 到 xxxhdpi
├── macos/AppIcon.iconset/         # macOS .iconset 目录
└── web/                           # favicon.ico、Web PNG、PWA icons
```

## 通用 PNG

包含尺寸：16x16, 20x20, 24x24, 29x29, 32x32, 40x40, 48x48, 50x50, 57x57, 58x58, 60x60, 64x64, 72x72, 76x76, 80x80, 87x87, 100x100, 114x114, 120x120, 128x128, 144x144, 152x152, 167x167, 180x180, 192x192, 256x256, 384x384, 512x512, 1024x1024。

## iOS AppIcon.appiconset

`ios/AppIcon.appiconset` 包含 `Contents.json`。iOS App Icon 通常要求不带透明通道，因此该目录下图片已通过代码合成到深色不透明背景上。

使用方式：

1. 打开 Xcode。
2. 进入 `Assets.xcassets`。
3. 将 `AppIcon.appiconset` 复制进去或替换现有 AppIcon。

## Android mipmap

每个密度目录包含 `ic_launcher.png` 和 `ic_launcher_round.png`。

| Density | Size |
|---|---:|
| mdpi | 48x48 |
| hdpi | 72x72 |
| xhdpi | 96x96 |
| xxhdpi | 144x144 |
| xxxhdpi | 192x192 |

使用方式：复制 `android/mipmap-*` 下的文件到 Android 项目的 `app/src/main/res/mipmap-*`。

## macOS .iconset

`macos/AppIcon.iconset` 包含 macOS 标准 iconset 文件名。在 macOS 上可以执行：

```bash
iconutil -c icns macos/AppIcon.iconset -o AppIcon.icns
```

## Web / PWA

`web/favicon.ico` 内含多个尺寸。PWA 常用图标在 `web/pwa/` 下，`web/manifest-icons.json` 提供可复制到 Web App Manifest 的 icons 配置片段。

## 处理说明

- 所有尺寸由代码使用 Lanczos 重采样生成。
- 除 iOS AppIcon 目录外，其余 PNG 保留透明通道。
