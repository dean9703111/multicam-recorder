import java.util.Properties

plugins {
    id("com.android.application")
}

// 發佈用的簽章金鑰不放進 git，設定寫在 android/keystore.properties（沒有這個檔案就只能編 debug 版）
val keystore = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "dev.multicam.recorder"
    compileSdk = 37 // OkHttp 5.5 要求；只影響編譯，minSdk 才決定能裝在哪些手機

    defaultConfig {
        applicationId = "dev.multicam.recorder"
        minSdk = 31 // Android 12
        targetSdk = 36
        versionCode = 9
        versionName = "0.6.0"
    }

    signingConfigs {
        if (!keystore.isEmpty) {
            create("release") {
                storeFile = file(keystore.getProperty("storeFile"))
                storePassword = keystore.getProperty("storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = keystore.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
        }
    }

    // App 回報給電腦的版本直接用 versionName（BuildConfig.VERSION_NAME）
    buildFeatures {
        buildConfig = true
    }

    lint {
        // 發佈前不跑 lint：Homebrew 的 JDK 在部分 macOS 上，lint 分析 Kotlin 時會載不到字型函式庫而當掉。
        // 要跑完整的 lint，請改用自帶 freetype 的 JDK（例如 Temurin）。
        checkReleaseBuilds = false
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
