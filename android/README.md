# Voidz.IO — Android app

A thin WebView wrapper around the dashboard (`https://voidz.io/`). It's a
real installable app (shows in your app drawer, own icon), not a PWA.

## Getting the APK (no local setup)

It's built in the cloud by GitHub Actions:

1. Go to the repo's **Actions** tab → **Build Android APK**.
2. Click **Run workflow** (or push a change under `android/`).
3. When the run goes green, open it and download the **`voidz-dashboard-apk`**
   artifact (a zip containing `app-debug.apk`).
4. Unzip, copy `app-debug.apk` to your phone, and tap it to install.
   You'll need to allow **"Install unknown apps"** for your file manager /
   browser the first time.

The APK is **debug-signed** — perfect for installing on your own phone.
(A debug APK can't be published to the Play Store, but you don't need that
to sideload it.)

## Building locally (optional)

Needs Android Studio (bundles the SDK + JDK 17 + Gradle):

```
cd android
gradle wrapper --gradle-version 8.7   # first time only
./gradlew assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/app-debug.apk`.

## Changing the URL

It's the `DASHBOARD_URL` constant in
`app/src/main/java/io/voidz/dashboard/MainActivity.java`.
