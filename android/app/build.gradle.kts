plugins {
    id("com.android.application")
}

android {
    namespace = "dev.multicam.recorder"
    compileSdk = 37 // OkHttp 5.5 要求；只影響編譯，minSdk 才決定能裝在哪些手機

    defaultConfig {
        applicationId = "dev.multicam.recorder"
        minSdk = 31 // Android 12；兩支手機都符合
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    // 掃 QR Code 用 Google Play 服務內建的掃描畫面，不用自己處理相機
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
